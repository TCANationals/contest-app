import { describe, it, expect } from 'vitest';
import { computeRemainingMs } from '../src/hooks/useTimer';
import type { TimerState } from '../src/store/types';

function makeState(partial: Partial<TimerState>): TimerState {
  return {
    room: 'test',
    version: 1,
    status: 'idle',
    endsAtServerMs: null,
    remainingMs: null,
    message: '',
    setBySub: 'system',
    setByEmail: '',
    setAtServerMs: 0,
    ...partial,
  };
}

describe('computeRemainingMs', () => {
  it('returns 0 for idle', () => {
    expect(computeRemainingMs(makeState({ status: 'idle' }), 0, 0)).toBe(0);
  });

  it('returns remainingMs for paused', () => {
    expect(
      computeRemainingMs(
        makeState({ status: 'paused', remainingMs: 12_000 }),
        0,
        0,
      ),
    ).toBe(12_000);
  });

  it('applies offset for running state', () => {
    const now = 1_000_000;
    const offset = -500; // local clock is 500 ms ahead of server
    const state = makeState({
      status: 'running',
      endsAtServerMs: now + offset + 30_000,
    });
    expect(computeRemainingMs(state, offset, now)).toBe(30_000);
  });

  it('clamps negative remaining to 0', () => {
    const now = 1_000_000;
    const state = makeState({
      status: 'running',
      endsAtServerMs: now - 5_000,
    });
    expect(computeRemainingMs(state, 0, now)).toBe(0);
  });
});
