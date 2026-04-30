import type { HelpQueueState } from "./help-queue.js";
import type { TimerState } from "./timer.js";

export interface RoomState {
  timer: TimerState;
  helpQueue: HelpQueueState;
}

const roomStates = new Map<string, RoomState>();

export function getOrCreateRoomState(roomId: string): RoomState {
  const existing = roomStates.get(roomId);
  if (existing) {
    return existing;
  }

  const created: RoomState = {
    timer: {
      room: roomId,
      version: 0,
      status: "idle",
      endsAtServerMs: null,
      remainingMs: null,
      message: "",
      setBySub: "system",
      setByEmail: "system",
      setAtServerMs: Date.now()
    },
    helpQueue: {
      room: roomId,
      version: 0,
      entries: []
    }
  };

  roomStates.set(roomId, created);
  return created;
}
