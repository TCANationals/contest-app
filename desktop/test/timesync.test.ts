import { describe, it, expect } from 'vitest';

import { computeSample, median, OffsetTracker } from '../src/timesync';

describe('computeSample', () => {
  it('recovers a synthetic 10s offset with symmetric latency', () => {
    const serverOffsetMs = 10_000;
    const latency = 50;
    const t0 = 1_000;
    const t1 = t0 + latency + serverOffsetMs;
    const t2 = t1 + 5;
    const t3 = t2 - serverOffsetMs + latency;
    const s = computeSample(t0, t1, t2, t3);
    expect(s.offset).toBeCloseTo(serverOffsetMs, 0);
    expect(s.roundTrip).toBeCloseTo(latency * 2, 0);
  });

  it('returns zero roundTrip only when client and server times match exactly', () => {
    const s = computeSample(0, 0, 0, 0);
    expect(s.offset).toBe(0);
    expect(s.roundTrip).toBe(0);
  });
});

describe('median', () => {
  it('returns the middle element of odd-length arrays', () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2, 5, 4])).toBe(3);
  });

  it('returns the mean of the two middle elements for even-length arrays', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns 0 for empty', () => {
    expect(median([])).toBe(0);
  });
});

describe('OffsetTracker', () => {
  it('returns null before any sample has arrived', () => {
    const t = new OffsetTracker();
    expect(t.activeOffsetMs()).toBeNull();
    expect(t.size()).toBe(0);
  });

  it('returns the plain median until trimming is possible', () => {
    const t = new OffsetTracker();
    t.push({ roundTrip: 10, offset: 100 });
    t.push({ roundTrip: 20, offset: 200 });
    expect(t.activeOffsetMs()).toBe(150);
  });

  it('drops the 2 worst-rtt samples before taking the median', () => {
    const t = new OffsetTracker();
    // 8 samples; two huge-RTT outliers carry a very wrong offset.
    for (const sample of [
      { roundTrip: 10, offset: 1 },
      { roundTrip: 12, offset: 2 },
      { roundTrip: 11, offset: 3 },
      { roundTrip: 13, offset: 4 },
      { roundTrip: 14, offset: 5 },
      { roundTrip: 15, offset: 6 },
      { roundTrip: 9_999, offset: 999 },
      { roundTrip: 9_998, offset: 1_000 },
    ]) {
      t.push(sample);
    }
    // After trimming the two 9_99x samples, remaining offsets are 1..6;
    // their median is 3.5.
    expect(t.activeOffsetMs()).toBe(3.5);
  });

  it('keeps only the last 8 samples in the window', () => {
    const t = new OffsetTracker();
    for (let i = 0; i < 12; i += 1) {
      t.push({ roundTrip: 10 + i, offset: i });
    }
    expect(t.size()).toBe(8);
  });

  it('clear() empties the window', () => {
    const t = new OffsetTracker();
    t.push({ roundTrip: 10, offset: 1 });
    t.clear();
    expect(t.activeOffsetMs()).toBeNull();
    expect(t.size()).toBe(0);
  });
});
