export type TimerStatus = "idle" | "running" | "paused";

export interface TimerState {
  room: string;
  version: number;
  status: TimerStatus;
  endsAtServerMs: number | null;
  remainingMs: number | null;
  message: string;
  setBySub: string;
  setByEmail: string;
  setAtServerMs: number;
}

export type TimerCommand =
  | { type: "TIMER_SET"; durationMs: number; message?: string }
  | { type: "TIMER_PAUSE" }
  | { type: "TIMER_RESUME" }
  | { type: "TIMER_ADJUST"; deltaMs: number }
  | { type: "TIMER_RESET" };

export function applyTimerCommand(_state: TimerState, _command: TimerCommand): TimerState {
  // TODO(spec §6.5): implement state transition table and validation.
  throw new Error("Not implemented: applyTimerCommand");
}
