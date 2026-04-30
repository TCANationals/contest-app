import { describe, expect, it } from 'vitest';

import { computeRemainingMs } from '../src/compute';
import type { TimerState } from '../src/types';

function baseState(overrides: Partial<TimerState> = {}): TimerState {
  return {
    room: 'r',
    version: 1,
    status: 'idle',
    endsAtServerMs: null,
    remainingMs: null,
    message: '',
    setBySub: 'x',
    setByEmail: 'x@example.com',
    setAtServerMs: 0,
    ...overrides,
  };
}

describe('computeRemainingMs', () => {
  it('returns 0 when idle', () => {
    expect(computeRemainingMs(baseState(), 0, 1_000)).toBe(0);
  });

  it('returns remainingMs when paused', () => {
    expect(
      computeRemainingMs(
        baseState({ status: 'paused', remainingMs: 12_345 }),
        123,
        0,
      ),
    ).toBe(12_345);
  });

  it('returns 0 for paused with null remainingMs (defensive)', () => {
    expect(
      computeRemainingMs(baseState({ status: 'paused' }), 0, 0),
    ).toBe(0);
  });

  it('returns 0 for running with null endsAtServerMs', () => {
    expect(
      computeRemainingMs(baseState({ status: 'running' }), 0, 0),
    ).toBe(0);
  });

  it('applies the active offset to running endsAtServerMs', () => {
    // Client wall clock is 5 s ahead of server (offset = -5_000).
    // serverNow = 120_000 + (-5_000) = 115_000; endsAt = 100_000 →
    // remaining = max(0, 100_000 - 115_000) = 0.
    const rem = computeRemainingMs(
      baseState({ status: 'running', endsAtServerMs: 100_000 }),
      -5_000,
      120_000,
    );
    expect(rem).toBe(0);
  });

  it('clamps negative to zero', () => {
    expect(
      computeRemainingMs(
        baseState({ status: 'running', endsAtServerMs: 1_000 }),
        0,
        5_000,
      ),
    ).toBe(0);
  });

  it('returns positive time when server endpoint is in the future', () => {
    expect(
      computeRemainingMs(
        baseState({ status: 'running', endsAtServerMs: 10_000 }),
        0,
        7_000,
      ),
    ).toBe(3_000);
  });

  it('applies a positive offset (server ahead of client)', () => {
    // Client clock is 2_000 ms behind server. Offset = +2_000 so
    // (now + offset) = serverNow.
    expect(
      computeRemainingMs(
        baseState({ status: 'running', endsAtServerMs: 50_000 }),
        2_000,
        45_000,
      ),
    ).toBe(3_000);
  });
});
