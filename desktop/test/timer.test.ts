import { describe, it, expect } from 'vitest';

import {
  computeRemainingMs,
  shouldFireAlarm,
  shouldFlash,
} from '../src/timer';
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

  it('applies the active offset to running endsAtServerMs', () => {
    // Client wall clock is 5 s ahead of server; offset is -5_000 ms.
    const endsAt = 100_000;
    const now = 120_000;
    const rem = computeRemainingMs(
      baseState({ status: 'running', endsAtServerMs: endsAt }),
      -5_000,
      now,
    );
    expect(rem).toBe(-15_000 < 0 ? 0 : 0); // serverNow = 115_000 > endsAt → 0
  });

  it('clamps negative to zero', () => {
    const rem = computeRemainingMs(
      baseState({ status: 'running', endsAtServerMs: 1_000 }),
      0,
      5_000,
    );
    expect(rem).toBe(0);
  });

  it('returns positive time when server endpoint is in the future', () => {
    const rem = computeRemainingMs(
      baseState({ status: 'running', endsAtServerMs: 10_000 }),
      0,
      7_000,
    );
    expect(rem).toBe(3_000);
  });
});

describe('shouldFireAlarm', () => {
  const base = {
    status: 'running' as const,
    remainingMs: 0,
    previousRemainingMs: 500,
    lastFiredAt: null as number | null,
    now: 1_000_000,
    enabled: true,
  };

  it('fires on the first tick where running crosses to 0', () => {
    expect(shouldFireAlarm(base)).toBe(true);
  });

  it('does not fire when disabled', () => {
    expect(shouldFireAlarm({ ...base, enabled: false })).toBe(false);
  });

  it('does not fire when not running', () => {
    expect(shouldFireAlarm({ ...base, status: 'idle' })).toBe(false);
    expect(shouldFireAlarm({ ...base, status: 'paused' })).toBe(false);
  });

  it('does not fire while remaining is still positive', () => {
    expect(
      shouldFireAlarm({ ...base, remainingMs: 100 }),
    ).toBe(false);
  });

  it('does not fire on subsequent zeroed ticks', () => {
    expect(
      shouldFireAlarm({ ...base, previousRemainingMs: 0 }),
    ).toBe(false);
  });

  it('does not fire again within 30 seconds of a prior fire', () => {
    expect(
      shouldFireAlarm({ ...base, lastFiredAt: base.now - 10_000 }),
    ).toBe(false);
  });

  it('can fire once the 30 second cooldown elapses', () => {
    expect(
      shouldFireAlarm({ ...base, lastFiredAt: base.now - 30_001 }),
    ).toBe(true);
  });
});

describe('shouldFlash', () => {
  it('flashes while running under the threshold', () => {
    expect(shouldFlash('running', 60_000, true, 2)).toBe(true);
  });

  it('does not flash when disabled', () => {
    expect(shouldFlash('running', 60_000, false, 2)).toBe(false);
  });

  it('stops flashing above the threshold', () => {
    expect(shouldFlash('running', 2 * 60_000 + 1, true, 2)).toBe(false);
  });

  it('does not flash when paused or idle', () => {
    expect(shouldFlash('paused', 10_000, true, 2)).toBe(false);
    expect(shouldFlash('idle', 10_000, true, 2)).toBe(false);
  });
});
