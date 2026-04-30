// Timer state machine (§6.5). Stubbed; business logic to be filled in.

export type TimerStatus = 'idle' | 'running' | 'paused';

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

export function initialTimerState(room: string): TimerState {
  return {
    room,
    version: 0,
    status: 'idle',
    endsAtServerMs: null,
    remainingMs: null,
    message: '',
    setBySub: 'system',
    setByEmail: '',
    setAtServerMs: Date.now(),
  };
}

export type TimerCommand =
  | { type: 'TIMER_SET'; durationMs: number; message?: string }
  | { type: 'TIMER_PAUSE' }
  | { type: 'TIMER_RESUME' }
  | { type: 'TIMER_ADJUST'; deltaMs: number }
  | { type: 'TIMER_RESET' };

export class TimerTransitionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// TODO: implement every transition in §6.5 with unit-test coverage.
export function applyTimerCommand(
  _state: TimerState,
  _cmd: TimerCommand,
  _actor: { sub: string; email: string },
  _now: number = Date.now(),
): TimerState {
  throw new TimerTransitionError(
    'NOT_IMPLEMENTED',
    'applyTimerCommand: not implemented',
  );
}
