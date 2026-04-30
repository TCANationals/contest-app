// In-memory RoomState map (§11.5). Stub for scaffolding.

import type { WebSocket } from 'ws';
import { initialHelpQueue, type HelpQueue } from './help-queue.js';
import { initialTimerState, type TimerState } from './timer.js';

export interface RoomState {
  timer: TimerState;
  helpQueue: HelpQueue;
  contestants: Set<WebSocket>;
  judges: Set<WebSocket>;
  notifyJobs: Map<string, NodeJS.Timeout>;
  judgeAckedAt: Map<string, number>;
}

const rooms = new Map<string, RoomState>();

export function getOrCreateRoomState(roomId: string): RoomState {
  let state = rooms.get(roomId);
  if (!state) {
    state = {
      timer: initialTimerState(roomId),
      helpQueue: initialHelpQueue(roomId),
      contestants: new Set(),
      judges: new Set(),
      notifyJobs: new Map(),
      judgeAckedAt: new Map(),
    };
    rooms.set(roomId, state);
  }
  return state;
}

export function getRoomState(roomId: string): RoomState | undefined {
  return rooms.get(roomId);
}

export function allRoomStates(): ReadonlyMap<string, RoomState> {
  return rooms;
}
