// RoomState (§11.5) — in-memory source of truth for one room's timer and
// help queue, with mutation discipline per §11.5:
//   1) mutate in-memory
//   2) begin async DB write
//   3) broadcast STATE / HELP_QUEUE (never await the DB write)

import type { WebSocket } from 'ws';
import {
  ServerOutboundFrameSchema,
  type ServerOutboundFrame,
} from '@tca-timer/shared/api';

import { initialHelpQueue, type HelpQueue, isInQueue } from './help-queue.js';
import { initialTimerState, type TimerState } from './timer.js';
import {
  insertAuditEvent,
  upsertTimerState,
  enqueueRetry,
  isDbDegraded,
  loadTimerState,
  type AuditEvent,
} from './db/dal.js';
import { scheduleNotification, type DispatchHandle } from './notify/dispatcher.js';

export interface RoomState {
  id: string;
  displayLabel: string;
  timer: TimerState;
  helpQueue: HelpQueue;
  contestants: Set<WebSocket>;
  judges: Set<WebSocket>;
  contestantIdBySocket: WeakMap<WebSocket, string>;
  notifyJobs: Map<string, { cancel: () => void }>;
  judgeAckedAt: Map<string, number>;
  offlineHelpLastPing: Map<string, number>;
}

const rooms = new Map<string, RoomState>();

export function getOrCreateRoomState(roomId: string, displayLabel = roomId): RoomState {
  let state = rooms.get(roomId);
  if (!state) {
    state = {
      id: roomId,
      displayLabel,
      timer: initialTimerState(roomId),
      helpQueue: initialHelpQueue(roomId),
      contestants: new Set(),
      judges: new Set(),
      contestantIdBySocket: new WeakMap(),
      notifyJobs: new Map(),
      judgeAckedAt: new Map(),
      offlineHelpLastPing: new Map(),
    };
    rooms.set(roomId, state);
  } else if (displayLabel && displayLabel !== roomId) {
    state.displayLabel = displayLabel;
  }
  return state;
}

export function getRoomState(roomId: string): RoomState | undefined {
  return rooms.get(roomId);
}

export function allRoomStates(): ReadonlyMap<string, RoomState> {
  return rooms;
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

/**
 * In dev and test builds, parse every outbound frame against the
 * §5.2 contract from `@tca-timer/shared/api` before it hits the
 * wire. A failure here indicates drift between the server and the
 * schema the SPA + contestant overlay parse with — we want those to
 * show up as a loud thrown error during `npm test` rather than as a
 * silent "undefined" reaching a client.
 *
 * Skipped in production (`NODE_ENV=production`) to keep the hot
 * broadcast path allocation-free: the schemas allocate transient
 * objects during parse, and broadcasts fire several times per second
 * under load.
 *
 * `ServerOutboundFrameSchema` is the union of every frame any client
 * (judge or contestant) is allowed to receive, so it works for every
 * builder below without needing to know which socket type a frame is
 * destined for at construction time.
 */
function assertOutboundFrameContract(frame: ServerOutboundFrame): void {
  if (process.env.NODE_ENV === 'production') return;
  const result = ServerOutboundFrameSchema.safeParse(frame);
  if (result.success) return;
  const detail = result.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  throw new Error(`outbound WS frame violates §5.2 contract: ${detail}`);
}

export function stateFrame(state: TimerState, connectedContestants: number): string {
  const frame: ServerOutboundFrame = {
    type: 'STATE',
    ...state,
    connectedContestants,
    dbDegraded: isDbDegraded(),
  };
  assertOutboundFrameContract(frame);
  return JSON.stringify(frame);
}

export function helpQueueFrame(queue: HelpQueue): string {
  const frame: ServerOutboundFrame = { type: 'HELP_QUEUE', ...queue };
  assertOutboundFrameContract(frame);
  return JSON.stringify(frame);
}

/**
 * Build a HELP_ACKED frame string for the targeted notify in §7.1
 * (judge-ack → contestant overlay clears `help_pending`).
 */
export function helpAckedFrame(
  room: string,
  contestantId: string,
  version: number,
  waitMs: number,
  ackedAtServerMs: number,
): string {
  const frame: ServerOutboundFrame = {
    type: 'HELP_ACKED',
    room,
    contestantId,
    version,
    waitMs,
    ackedAtServerMs,
  };
  assertOutboundFrameContract(frame);
  return JSON.stringify(frame);
}

/**
 * Build a PONG frame string. Centralized here (alongside `stateFrame`
 * and `helpQueueFrame`) so every frame the server emits on the wire
 * flows through the same §5.2 contract check.
 */
export function pongFrame(t0: number, t1: number, t2: number): string {
  const frame: ServerOutboundFrame = { type: 'PONG', t0, t1, t2 };
  assertOutboundFrameContract(frame);
  return JSON.stringify(frame);
}

/**
 * Build an ERROR frame string. Same rationale as `pongFrame`.
 */
export function errorFrame(code: string, message: string): string {
  const frame: ServerOutboundFrame = { type: 'ERROR', code, message };
  assertOutboundFrameContract(frame);
  return JSON.stringify(frame);
}

export function broadcastState(room: RoomState): void {
  const frame = stateFrame(room.timer, room.contestants.size);
  for (const s of room.contestants) safeSend(s, frame);
  for (const s of room.judges) safeSend(s, frame);
}

export function broadcastHelpQueueToJudges(room: RoomState): void {
  const frame = helpQueueFrame(room.helpQueue);
  for (const s of room.judges) safeSend(s, frame);
}

/**
 * §7.1 targeted notify: tell the contestant whose help request was
 * just acknowledged by a judge so their overlay can clear
 * `help_pending` and show the spec'd "Judge acknowledged" toast.
 *
 * Multiple sockets can claim the same `contestantId` (rare but
 * possible — e.g. the contestant has two windows open or briefly
 * doubled-up during a reconnect race). All matching sockets are
 * notified; non-matches are skipped.
 */
export function notifyContestantHelpAcked(
  room: RoomState,
  contestantId: string,
  version: number,
  waitMs: number,
  ackedAtServerMs: number,
): void {
  const frame = helpAckedFrame(
    room.id,
    contestantId,
    version,
    waitMs,
    ackedAtServerMs,
  );
  for (const s of room.contestants) {
    if (room.contestantIdBySocket.get(s) === contestantId) {
      safeSend(s, frame);
    }
  }
}

export function safeSend(socket: WebSocket, frame: string): void {
  try {
    if (socket.readyState === 1 /* OPEN */) socket.send(frame);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers. Every state-changing operation SHOULD call these two
// helpers after mutating in-memory state.
// ---------------------------------------------------------------------------

export function persistTimer(state: TimerState): void {
  const snapshot = { ...state };
  (async () => {
    try {
      await upsertTimerState(snapshot);
    } catch {
      enqueueRetry(() => upsertTimerState(snapshot));
    }
  })();
}

export function writeAudit(ev: AuditEvent): void {
  // Snapshot the event before we hand it off to the async path. If the
  // caller later mutates `ev.payload` (or reuses the same object for a
  // different event) while our INSERT is in flight or parked on the
  // retry ring, we must still persist the values that were true at the
  // time the event was written. This mirrors the defensive copy that
  // `persistTimer` already performs on the `TimerState` snapshot.
  const snapshot: AuditEvent = {
    room: ev.room,
    atServerMs: ev.atServerMs,
    actorSub: ev.actorSub,
    actorEmail: ev.actorEmail,
    eventType: ev.eventType,
    payload:
      ev.payload == null
        ? {}
        : typeof ev.payload === 'object'
          ? structuredClone(ev.payload)
          : ev.payload,
  };
  (async () => {
    try {
      await insertAuditEvent(snapshot);
    } catch {
      enqueueRetry(() => insertAuditEvent(snapshot));
    }
  })();
}

// ---------------------------------------------------------------------------
// Post-restart warm-up: load timer_state rows for any rooms that have them.
// ---------------------------------------------------------------------------

export async function rehydrateFromDb(roomIds: string[]): Promise<void> {
  for (const id of roomIds) {
    const state = getOrCreateRoomState(id);
    const loaded = await loadTimerState(id).catch(() => null);
    if (loaded) state.timer = loaded;
  }
}

/**
 * Schedule the 5-second notification debounce job for the current head of
 * the queue. Idempotent: no-op if a job is already scheduled for the head.
 *
 * Called (a) on the empty→non-empty transition in the contestant handler,
 * and (b) whenever an existing head is removed (self-cancel or judge ack)
 * while other contestants are still waiting — otherwise the remaining
 * entries would never trigger a notification.
 */
export function scheduleHeadNotification(
  room: RoomState,
  displayLabel: string = room.displayLabel,
  publicOrigin: string = process.env.PUBLIC_ORIGIN ?? '',
): void {
  const head = room.helpQueue.entries[0];
  if (!head) return;
  if (room.notifyJobs.has(head.contestantId)) return;
  const handle: DispatchHandle = scheduleNotification({
    room: room.id,
    displayLabel,
    contestantId: head.contestantId,
    requestedAtServerMs: head.requestedAtServerMs,
    getQueue: () => room.helpQueue,
    judgeAckedAt: room.judgeAckedAt,
    publicOrigin,
  });
  room.notifyJobs.set(head.contestantId, handle);
}

export function _resetRooms(): void {
  rooms.clear();
}

// Re-export so downstream modules don't need to reach into help-queue.ts
// directly when they already have RoomState.
export { isInQueue };
