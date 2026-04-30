// Timer state machine (§6.5).

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

export function initialTimerState(room: string, now: number = Date.now()): TimerState {
  return {
    room,
    version: 0,
    status: 'idle',
    endsAtServerMs: null,
    remainingMs: null,
    message: '',
    setBySub: 'system',
    setByEmail: '',
    setAtServerMs: now,
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
    this.name = 'TimerTransitionError';
  }
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Apply a timer command to the current state. Returns the new state.
 * Throws TimerTransitionError on invalid transitions or inputs; callers
 * should translate the error into an ERROR wire frame (see §5.2).
 */
export function applyTimerCommand(
  state: TimerState,
  cmd: TimerCommand,
  actor: { sub: string; email: string },
  now: number = Date.now(),
): TimerState {
  const base: TimerState = {
    ...state,
    version: state.version + 1,
    setBySub: actor.sub,
    setByEmail: actor.email,
    setAtServerMs: now,
  };

  switch (cmd.type) {
    case 'TIMER_SET': {
      if (!isFiniteNumber(cmd.durationMs) || cmd.durationMs < 0) {
        throw new TimerTransitionError('BAD_DURATION', 'durationMs must be a non-negative finite number');
      }
      return {
        ...base,
        status: 'running',
        endsAtServerMs: now + cmd.durationMs,
        remainingMs: null,
        message: typeof cmd.message === 'string' ? cmd.message : state.message,
      };
    }

    case 'TIMER_PAUSE': {
      if (state.status !== 'running') {
        throw new TimerTransitionError('BAD_STATE', `cannot pause from ${state.status}`);
      }
      const endsAt = state.endsAtServerMs ?? now;
      return {
        ...base,
        status: 'paused',
        endsAtServerMs: null,
        remainingMs: Math.max(0, endsAt - now),
      };
    }

    case 'TIMER_RESUME': {
      if (state.status !== 'paused') {
        throw new TimerTransitionError('BAD_STATE', `cannot resume from ${state.status}`);
      }
      const remaining = state.remainingMs ?? 0;
      return {
        ...base,
        status: 'running',
        endsAtServerMs: now + remaining,
        remainingMs: null,
      };
    }

    case 'TIMER_ADJUST': {
      if (!isFiniteNumber(cmd.deltaMs)) {
        throw new TimerTransitionError('BAD_DELTA', 'deltaMs must be a finite number');
      }
      if (state.status === 'running') {
        const endsAt = (state.endsAtServerMs ?? now) + cmd.deltaMs;
        return {
          ...base,
          status: 'running',
          endsAtServerMs: Math.max(now, endsAt),
          remainingMs: null,
        };
      }
      if (state.status === 'paused') {
        return {
          ...base,
          status: 'paused',
          endsAtServerMs: null,
          remainingMs: Math.max(0, (state.remainingMs ?? 0) + cmd.deltaMs),
        };
      }
      throw new TimerTransitionError('BAD_STATE', 'cannot adjust from idle');
    }

    case 'TIMER_RESET': {
      return {
        ...base,
        status: 'idle',
        endsAtServerMs: null,
        remainingMs: null,
      };
    }
  }
}
