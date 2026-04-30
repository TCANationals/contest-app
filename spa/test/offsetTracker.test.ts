import { describe, expect, it } from 'vitest';

import { OffsetTracker } from '../src/hooks/useTimer';

describe('OffsetTracker', () => {
  it('returns 0 when no samples collected', () => {
    expect(new OffsetTracker().getActiveOffset()).toBe(0);
  });

  it('uses all samples until window is full', () => {
    const t = new OffsetTracker();
    // offset = ((t1 - t0) + (t2 - t3)) / 2
    t.addSample(0, 100, 100, 20); // offset = (100 + 80) / 2 = 90, rtt = 20
    t.addSample(0, 50, 50, 10); // offset = (50 + 40) / 2 = 45, rtt = 10
    expect(t.sampleCount).toBe(2);
    // median of [45, 90] → 67.5
    expect(t.getActiveOffset()).toBe(67.5);
  });

  it('drops two worst RTTs when window of 8 is full', () => {
    const tracker = new OffsetTracker();
    // Add 6 low-RTT, low-offset samples, then 2 huge-RTT outliers with
    // very different offsets that MUST be discarded.
    for (let i = 0; i < 6; i++) {
      // rtt=10, offset=100
      tracker.addSample(0, 105, 105, 10);
    }
    // rtt=500, offset=1000
    tracker.addSample(0, 1000 + 500 / 2, 1000 + 500 / 2, 500);
    // rtt=600, offset=2000
    tracker.addSample(0, 2000 + 600 / 2, 2000 + 600 / 2, 600);
    expect(tracker.sampleCount).toBe(8);
    // After dropping the two worst by RTT, only the 6 offset=100 samples remain.
    expect(tracker.getActiveOffset()).toBe(100);
  });

  it('is bounded to the last 8 samples', () => {
    const t = new OffsetTracker();
    for (let i = 0; i < 20; i++) {
      t.addSample(0, 10, 10, 5);
    }
    expect(t.sampleCount).toBe(8);
  });
});
