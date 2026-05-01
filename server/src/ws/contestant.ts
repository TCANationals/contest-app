// /contestant WebSocket handler (§5.1, §5.2, §6.3, §6.4, §7).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import {
  CONTESTANT_ID_REGEX,
  ROOM_KEY_REGEX,
} from '../auth/identifiers.js';
import {
  getOrCreateRoomState,
  broadcastHelpQueueToJudges,
  stateFrame,
  pongFrame,
  errorFrame,
  safeSend,
  writeAudit,
  scheduleHeadNotification,
  type RoomState,
} from '../rooms.js';
import { getRoomByKey, getStationNumber } from '../db/dal.js';
import { helpRequest, helpCancel } from '../help-queue.js';
import {
  RateLimiter,
  APPLICATION_HEARTBEAT_TIMEOUT_MS,
  ROOM_CONNECTION_CAP,
  type LimitKey,
} from '../ratelimit.js';

interface ContestantSocketCtx {
  room: RoomState;
  contestantId: string;
  displayLabel: string;
  limiter: RateLimiter;
  lastPingAt: number;
  heartbeat: NodeJS.Timeout;
}

export function registerContestantWs(app: FastifyInstance): void {
  app.get(
    '/contestant',
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const query = req.query as { key?: string; id?: string };
      const roomKey = query.key ?? '';
      const rawId = query.id ?? '';
      const contestantId = rawId.toLowerCase();

      if (!ROOM_KEY_REGEX.test(roomKey)) return closeWith(socket, 1008, 'bad_key');
      if (!CONTESTANT_ID_REGEX.test(contestantId)) return closeWith(socket, 1008, 'bad_contestant');

      const roomRow = await getRoomByKey(roomKey).catch(() => null);
      if (!roomRow || roomRow.archived_at) return closeWith(socket, 1008, 'unknown_room');

      const room = getOrCreateRoomState(roomRow.id, roomRow.display_label);
      if (room.judges.size + room.contestants.size >= ROOM_CONNECTION_CAP) {
        return closeWith(socket, 1008, 'room_full');
      }

      const ctx: ContestantSocketCtx = {
        room,
        contestantId,
        displayLabel: roomRow.display_label,
        limiter: new RateLimiter(),
        lastPingAt: Date.now(),
        heartbeat: makeUnref(
          setInterval(() => {
            if (Date.now() - ctx.lastPingAt > APPLICATION_HEARTBEAT_TIMEOUT_MS) {
              closeWith(socket, 1011, 'heartbeat_timeout');
            }
          }, 10_000),
        ),
      };

      room.contestants.add(socket);
      room.contestantIdBySocket.set(socket, contestantId);

      safeSend(socket, stateFrame(room.timer, room.contestants.size));

      socket.on('message', (data: Buffer) => {
        ctx.lastPingAt = Date.now();
        handleContestantFrame(ctx, socket, data);
      });

      socket.on('close', () => {
        clearInterval(ctx.heartbeat);
        room.contestants.delete(socket);
        room.contestantIdBySocket.delete(socket);
      });

      socket.on('error', () => {});
    },
  );
}

function handleContestantFrame(
  ctx: ContestantSocketCtx,
  socket: WebSocket,
  data: Buffer,
): void {
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(data.toString('utf8'));
  } catch {
    sendError(socket, 'BAD_JSON', 'frame is not JSON');
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    sendError(socket, 'BAD_FRAME', 'missing type');
    return;
  }

  const type = msg.type;
  const limitKey = limitKeyFor(type);
  if (limitKey) {
    const r = ctx.limiter.consume(limitKey);
    if (!r.allowed) {
      if (r.abusive) {
        writeAudit({
          room: ctx.room.id,
          atServerMs: Date.now(),
          actorSub: ctx.contestantId,
          actorEmail: null,
          eventType: 'RATE_LIMIT_CLOSE',
          payload: { frameType: type, count: r.droppedCount },
        });
        closeWith(socket, 1008, 'rate_limit');
      }
      return;
    }
  }

  switch (type) {
    case 'PING': {
      const t0 = typeof msg.t0 === 'number' ? msg.t0 : 0;
      const t1 = Date.now();
      const t2 = Date.now();
      safeSend(socket, pongFrame(t0, t1, t2));
      return;
    }

    case 'HELP_REQUEST': {
      void handleHelpRequest(ctx).catch(() => {});
      return;
    }

    case 'HELP_CANCEL': {
      handleHelpCancel(ctx);
      return;
    }

    default:
      sendError(socket, 'BAD_FRAME', `unknown type ${type}`);
  }
}

async function handleHelpRequest(ctx: ContestantSocketCtx): Promise<void> {
  // The empty-check + queue mutation + schedule decision is kept fully
  // synchronous. Doing the station-number lookup before mutating the queue
  // would let a concurrent HELP_REQUEST sneak in during the `await` and
  // cause us to mis-observe `wasEmpty=true` for a second triggering
  // contestant, resulting in duplicate notification jobs.
  const wasEmpty = ctx.room.helpQueue.entries.length === 0;
  const res = helpRequest(ctx.room.helpQueue, ctx.contestantId, null);
  if (!res.changed) return;
  ctx.room.helpQueue = res.queue;

  writeAudit({
    room: ctx.room.id,
    atServerMs: Date.now(),
    actorSub: ctx.contestantId,
    actorEmail: null,
    eventType: 'HELP_REQUEST',
    payload: {},
  });
  broadcastHelpQueueToJudges(ctx.room);

  if (wasEmpty) {
    scheduleHeadNotification(ctx.room, ctx.displayLabel);
  }


  // Look up the station number after the state change is committed. If
  // we get one, replace the queue with a new immutable copy that carries
  // the station number AND a bumped version, then rebroadcast so any
  // version-deduping client picks up the change. Mutating the existing
  // entry in place would leave `queue.version` unchanged and clients
  // that short-circuit on a seen version would miss the station number.
  const station = await getStationNumber(ctx.room.id, ctx.contestantId).catch(() => null);
  if (station == null) return;
  const idx = ctx.room.helpQueue.entries.findIndex((e) => e.contestantId === ctx.contestantId);
  if (idx < 0) return;
  const current = ctx.room.helpQueue.entries[idx]!;
  if (current.stationNumber === station) return;
  const nextEntries = [...ctx.room.helpQueue.entries];
  nextEntries[idx] = { ...current, stationNumber: station };
  ctx.room.helpQueue = {
    ...ctx.room.helpQueue,
    version: ctx.room.helpQueue.version + 1,
    entries: nextEntries,
  };
  broadcastHelpQueueToJudges(ctx.room);
}

function handleHelpCancel(ctx: ContestantSocketCtx): void {
  const res = helpCancel(ctx.room.helpQueue, ctx.contestantId);
  if (!res.changed) return;
  ctx.room.helpQueue = res.queue;

  const existing = ctx.room.notifyJobs.get(ctx.contestantId);
  if (existing) {
    existing.cancel();
    ctx.room.notifyJobs.delete(ctx.contestantId);
    // If the canceled entry was the head of the queue and there are still
    // other contestants waiting, restart the 5-second notify debounce for
    // the new head. Otherwise judges whose notification was debounced on
    // the canceled requester would never be alerted to the remaining
    // queue entries.
    if (ctx.room.helpQueue.entries.length > 0) {
      scheduleHeadNotification(ctx.room, ctx.displayLabel);
    }
  }

  writeAudit({
    room: ctx.room.id,
    atServerMs: Date.now(),
    actorSub: ctx.contestantId,
    actorEmail: null,
    eventType: 'HELP_CANCEL',
    payload: {},
  });
  broadcastHelpQueueToJudges(ctx.room);
}

function limitKeyFor(type: string): LimitKey | null {
  switch (type) {
    case 'PING': return 'PING';
    case 'HELP_REQUEST': return 'HELP_REQUEST';
    case 'HELP_CANCEL': return 'HELP_CANCEL';
    default: return null;
  }
}

function sendError(socket: WebSocket, code: string, message: string): void {
  safeSend(socket, errorFrame(code, message));
}

function closeWith(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}

function makeUnref(t: NodeJS.Timeout): NodeJS.Timeout {
  t.unref?.();
  return t;
}
