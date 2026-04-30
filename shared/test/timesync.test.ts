import { describe, expect, it } from 'vitest';

import {
  computeSample,
  median,
  OffsetTracker,
} from '../src/timesync';

describe('computeSample', () => {
  it('matches the §6.3 NTP-style formulas', () => {
    // t0=0, t1=100, t2=100, t3=20:
    // roundTrip = 20 - 0 - (100 - 100) = 20
    // offset    = ((100 - 0) + (100 - 20)) / 2 = 90
    expect(computeSample(0, 100, 100, 20)).toEqual({
      roundTrip: 20,
      offset: 90,
    });
  });

  it('returns zero offset when both clocks agree', () => {
    expect(computeSample(0, 50, 60, 110)).toEqual({
      roundTrip: 100,
      offset: 0,
    });
  });
});

describe('median', () => {
  it('returns 0 for empty input', () => {
    expect(median([])).toBe(0);
  });

  it('returns the middle of an odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middles of an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('does not mutate input', () => {
    const arr = [3, 1, 2];
    median(arr);
    expect(arr).toEqual([3, 1, 2]);
  });
});

describe('OffsetTracker', () => {
  it('returns null when no samples collected', () => {
    expect(new OffsetTracker().activeOffsetMs()).toBe(null);
  });

  it('uses all samples until window has more than TRIM_WORST', () => {
    const t = new OffsetTracker();
    // Two samples, TRIM_WORST = 2 → keep both, take their median.
    t.push({ roundTrip: 10, offset: 100 });
    t.push({ roundTrip: 20, offset: 200 });
    expect(t.size()).toBe(2);
    // median([100, 200]) = 150
    expect(t.activeOffsetMs()).toBe(150);
  });

  it('drops the two worst RTTs once the window has more than TRIM_WORST samples', () => {
    const t = new OffsetTracker();
    // 6 low-RTT, low-offset samples + 2 huge-RTT outliers with very
    // different offsets that MUST be discarded.
    for (let i = 0; i < 6; i++) {
      t.push({ roundTrip: 10, offset: 100 });
    }
    t.push({ roundTrip: 500, offset: 1_000 });
    t.push({ roundTrip: 600, offset: 2_000 });
    expect(t.size()).toBe(8);
    // After dropping the two worst by RTT, only the 6 offset=100
    // samples remain → median is 100.
    expect(t.activeOffsetMs()).toBe(100);
  });

  it('is bounded to the last 8 samples', () => {
    const t = new OffsetTracker();
    for (let i = 0; i < 20; i++) {
      t.push({ roundTrip: 10, offset: 5 });
    }
    expect(t.size()).toBe(8);
  });

  it('clear() empties the window', () => {
    const t = new OffsetTracker();
    t.push({ roundTrip: 10, offset: 5 });
    t.clear();
    expect(t.size()).toBe(0);
    expect(t.activeOffsetMs()).toBe(null);
  });

  it('pushFromTimestamps wires through computeSample', () => {
    const t = new OffsetTracker();
    t.pushFromTimestamps(0, 100, 100, 20);
    expect(t.size()).toBe(1);
    expect(t.activeOffsetMs()).toBe(90);
  });
});
