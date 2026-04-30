// RoomState (§11.5) — in-memory source of truth for one room's timer and
// help queue, with mutation discipline per §11.5:
//   1) mutate in-memory
//   2) begin async DB write
//   3) broadcast STATE / HELP_QUEUE (never await the DB write)

import type { WebSocket } from 'ws';
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

export function stateFrame(state: TimerState, connectedContestants: number): string {
  return JSON.stringify({
    type: 'STATE',
    ...state,
    connectedContestants,
    dbDegraded: isDbDegraded(),
  });
}

export function helpQueueFrame(queue: HelpQueue): string {
  return JSON.stringify({
    type: 'HELP_QUEUE',
    ...queue,
  });
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
  (async () => {
    try {
      await insertAuditEvent(ev);
    } catch {
      enqueueRetry(() => insertAuditEvent(ev));
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
