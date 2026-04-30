// /judge WebSocket handler (§5.1, §5.2, §6.3, §6.4, §6.5, §7).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import { ticketCache, hasRoomAccess, type TicketRecord } from '../auth/cf-jwt.js';
import { ROOM_ID_REGEX } from '../auth/room-token.js';
import {
  getOrCreateRoomState,
  broadcastState,
  broadcastHelpQueueToJudges,
  helpQueueFrame,
  notifyContestantHelpAcked,
  stateFrame,
  pongFrame,
  errorFrame,
  safeSend,
  writeAudit,
  persistTimer,
  scheduleHeadNotification,
  type RoomState,
} from '../rooms.js';
import { getRoom } from '../db/dal.js';
import { helpAck } from '../help-queue.js';
import { applyTimerCommand, TimerTransitionError, type TimerCommand } from '../timer.js';
import {
  RateLimiter,
  APPLICATION_HEARTBEAT_TIMEOUT_MS,
  ROOM_CONNECTION_CAP,
  type LimitKey,
} from '../ratelimit.js';

interface JudgeSocketCtx {
  room: RoomState;
  identity: { sub: string; email: string; groups: string[] };
  limiter: RateLimiter;
  lastPingAt: number;
  heartbeat: NodeJS.Timeout;
}

export function registerJudgeWs(app: FastifyInstance): void {
  app.get(
    '/judge',
    { websocket: true },
    async (socket: WebSocket, req: FastifyRequest) => {
      const query = req.query as { room?: string; ticket?: string };
      const roomId = query.room ?? '';
      const ticket = query.ticket ?? '';

      if (!ROOM_ID_REGEX.test(roomId)) return closeWith(socket, 1008, 'bad_room');

      const roomRow = await getRoom(roomId).catch(() => null);
      if (!roomRow || roomRow.archived_at) return closeWith(socket, 1008, 'unknown_room');

      const rec: TicketRecord | null = ticketCache.redeem(ticket);
      if (!rec) return closeWith(socket, 1008, 'bad_ticket');
      if (!hasRoomAccess(rec.groups, roomId)) return closeWith(socket, 1008, 'forbidden_room');

      const room = getOrCreateRoomState(roomId, roomRow.display_label);
      if (room.judges.size + room.contestants.size >= ROOM_CONNECTION_CAP) {
        return closeWith(socket, 1008, 'room_full');
      }

      const ctx: JudgeSocketCtx = {
        room,
        identity: { sub: rec.sub, email: rec.email, groups: rec.groups },
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

      room.judges.add(socket);

      safeSend(socket, stateFrame(room.timer, room.contestants.size));
      safeSend(socket, helpQueueFrame(room.helpQueue));

      socket.on('message', (data: Buffer) => {
        ctx.lastPingAt = Date.now();
        handleJudgeFrame(ctx, socket, data);
      });

      socket.on('close', () => {
        clearInterval(ctx.heartbeat);
        room.judges.delete(socket);
      });

      socket.on('error', () => {});
    },
  );
}

function handleJudgeFrame(ctx: JudgeSocketCtx, socket: WebSocket, data: Buffer): void {
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
          actorSub: ctx.identity.sub,
          actorEmail: ctx.identity.email,
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

    case 'TIMER_SET':
    case 'TIMER_PAUSE':
    case 'TIMER_RESUME':
    case 'TIMER_ADJUST':
    case 'TIMER_RESET':
    case 'MESSAGE_SET': {
      const cmd = parseTimerCmd(type, msg);
      if (!cmd) {
        sendError(socket, 'BAD_FRAME', 'invalid timer command');
        return;
      }
      const prev = ctx.room.timer;
      try {
        const next = applyTimerCommand(prev, cmd, ctx.identity);
        ctx.room.timer = next;
        persistTimer(next);
        writeAudit({
          room: ctx.room.id,
          atServerMs: next.setAtServerMs,
          actorSub: ctx.identity.sub,
          actorEmail: ctx.identity.email,
          eventType: cmd.type,
          payload: timerAuditPayload(cmd, prev, next),
        });
        broadcastState(ctx.room);
      } catch (err) {
        if (err instanceof TimerTransitionError) {
          sendError(socket, err.code, err.message);
        } else {
          sendError(socket, 'INTERNAL', 'timer command failed');
        }
      }
      return;
    }

    case 'HELP_ACK': {
      const contestantId = typeof msg.contestantId === 'string' ? msg.contestantId : '';
      const expectedVersion =
        typeof msg.version === 'number' ? msg.version : ctx.room.helpQueue.version;
      if (!contestantId) {
        sendError(socket, 'BAD_FRAME', 'missing contestantId');
        return;
      }
      const now = Date.now();
      const res = helpAck(ctx.room.helpQueue, contestantId, expectedVersion, now);
      if (!res.changed) return;

      ctx.room.helpQueue = res.queue;
      ctx.room.judgeAckedAt.set(ctx.identity.sub, now);

      const notifyJob = ctx.room.notifyJobs.get(contestantId);
      if (notifyJob) {
        notifyJob.cancel();
        ctx.room.notifyJobs.delete(contestantId);
        // If other contestants are still waiting, kick off a fresh
        // 5-second debounce for the new head. Otherwise judges who were
        // debounced on the acked requester would never be alerted to the
        // remaining queue entries.
        if (ctx.room.helpQueue.entries.length > 0) {
          scheduleHeadNotification(ctx.room);
        }
      }

      writeAudit({
        room: ctx.room.id,
        atServerMs: Date.now(),
        actorSub: ctx.identity.sub,
        actorEmail: ctx.identity.email,
        eventType: 'HELP_ACK',
        payload: { contestantId, waitMs: res.waitMs ?? 0 },
      });

      broadcastHelpQueueToJudges(ctx.room);
      // §7.1: tell the affected contestant their help_pending state
      // has cleared. Without this, the overlay's button stays stuck in
      // the "pending" color until the contestant manually toggles it.
      notifyContestantHelpAcked(
        ctx.room,
        contestantId,
        ctx.room.helpQueue.version,
        res.waitMs ?? 0,
        now,
      );
      return;
    }

    default:
      sendError(socket, 'BAD_FRAME', `unknown type ${type}`);
  }
}

function limitKeyFor(type: string): LimitKey | null {
  switch (type) {
    case 'PING': return 'PING';
    case 'HELP_ACK': return 'HELP_ACK';
    case 'TIMER_SET':
    case 'TIMER_PAUSE':
    case 'TIMER_RESUME':
    case 'TIMER_ADJUST':
    case 'TIMER_RESET':
    case 'MESSAGE_SET':
      return 'TIMER';
    default:
      return null;
  }
}

function parseTimerCmd(type: string, msg: { [k: string]: unknown }): TimerCommand | null {
  switch (type) {
    case 'TIMER_SET': {
      const d = msg.durationMs;
      if (typeof d !== 'number' || !Number.isFinite(d) || d < 0) return null;
      const message = typeof msg.message === 'string' ? msg.message : undefined;
      return message != null
        ? { type: 'TIMER_SET', durationMs: d, message }
        : { type: 'TIMER_SET', durationMs: d };
    }
    case 'TIMER_PAUSE': return { type: 'TIMER_PAUSE' };
    case 'TIMER_RESUME': return { type: 'TIMER_RESUME' };
    case 'TIMER_ADJUST': {
      const delta = msg.deltaMs;
      if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
      return { type: 'TIMER_ADJUST', deltaMs: delta };
    }
    case 'TIMER_RESET': return { type: 'TIMER_RESET' };
    case 'MESSAGE_SET': {
      const message = msg.message;
      if (typeof message !== 'string') return null;
      return { type: 'MESSAGE_SET', message };
    }
    default: return null;
  }
}

function timerAuditPayload(
  cmd: TimerCommand,
  _prev: { status: string; endsAtServerMs: number | null; remainingMs: number | null },
  next: { endsAtServerMs: number | null; remainingMs: number | null },
): Record<string, unknown> {
  switch (cmd.type) {
    case 'TIMER_SET':
      return { durationMs: cmd.durationMs, message: cmd.message ?? '' };
    case 'TIMER_PAUSE':
      return { remainingMs: next.remainingMs ?? 0 };
    case 'TIMER_RESUME':
      return { endsAtServerMs: next.endsAtServerMs ?? 0 };
    case 'TIMER_ADJUST':
      return {
        deltaMs: cmd.deltaMs,
        newEndsAtServerMs: next.endsAtServerMs,
        newRemainingMs: next.remainingMs,
      };
    case 'TIMER_RESET':
      return {};
    case 'MESSAGE_SET':
      return { message: cmd.message };
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
