import { describe, it, expect } from 'vitest';

import {
  alarmBaselineKey,
  shouldFireAlarm,
} from '../src/alarm';
import type { TimerState } from '../src/types';

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

describe('alarmBaselineKey', () => {
  const base: TimerState = {
    room: 'r1',
    version: 3,
    status: 'running',
    endsAtServerMs: 1_700_000_000_000,
    remainingMs: null,
    message: '',
    setBySub: '',
    setByEmail: '',
    setAtServerMs: 0,
  };

  it('matches for logically identical timer state', () => {
    const a = { ...base };
    const b = { ...base, message: 'display-only change' };
    expect(alarmBaselineKey(a)).toBe(alarmBaselineKey(b));
  });

  it('changes when server timer fields change', () => {
    expect(alarmBaselineKey(base)).not.toBe(
      alarmBaselineKey({ ...base, version: 4 }),
    );
  });
});
