// §6.3 time-sync: median-of-6 offset tracker built from a sliding
// window of 8 (roundTrip, offset) samples.
//
// Pure module — no DOM, no WS, no React.

import type { OffsetSample } from './types';

/**
 * Compute a single sample from the four clock readings that frame a
 * PING/PONG exchange (standard NTP-style formulas):
 *
 *   roundTrip = (t3 - t0) - (t2 - t1)
 *   offset    = ((t1 - t0) + (t2 - t3)) / 2
 *
 * - `t0`: client wall-clock when it sent the PING.
 * - `t1`: server wall-clock when it received the PING.
 * - `t2`: server wall-clock when it sent the PONG.
 * - `t3`: client wall-clock when it received the PONG.
 */
export function computeSample(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): OffsetSample {
  return {
    roundTrip: t3 - t0 - (t2 - t1),
    offset: (t1 - t0 + (t2 - t3)) / 2,
  };
}

/**
 * Return the median of `values` (mid-value for odd length, mean of
 * two middles for even length). Does not mutate input. Returns `0`
 * for an empty array — callers that need a "no samples" sentinel
 * should check upstream.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[(n - 1) >> 1]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/**
 * Maintain a sliding window of the last 8 samples per §6.3. The
 * active offset is the median of the remaining 6 after dropping the
 * 2 largest-RTT samples; until the window has filled, the plain
 * median of what is available is returned (so the warm-up burst can
 * still produce a reasonable offset before steady state).
 *
 * Both consumer apps wrap this class with their own thin facade
 * (`addSample` vs `push`, etc) but the storage and trimming logic
 * lives once, here.
 */
export class OffsetTracker {
  private readonly window: OffsetSample[] = [];
  /** Visible for the §6.3 tests. */
  static readonly CAPACITY = 8;
  /** Number of worst-RTT samples to drop before taking the median. */
  static readonly TRIM_WORST = 2;

  /** Push a pre-computed sample into the window. */
  push(sample: OffsetSample): void {
    this.window.push(sample);
    if (this.window.length > OffsetTracker.CAPACITY) {
      this.window.shift();
    }
  }

  /** Convenience: compute + push from raw clock readings. */
  pushFromTimestamps(t0: number, t1: number, t2: number, t3: number): void {
    this.push(computeSample(t0, t1, t2, t3));
  }

  /** Number of samples currently held. */
  size(): number {
    return this.window.length;
  }

  /**
   * Median offset (ms) after trimming the two worst-RTT samples.
   * Returns `null` when no samples have been collected yet.
   */
  activeOffsetMs(): number | null {
    if (this.window.length === 0) return null;
    if (this.window.length <= OffsetTracker.TRIM_WORST) {
      return median(this.window.map((s) => s.offset));
    }
    const byRtt = [...this.window].sort(
      (a, b) => a.roundTrip - b.roundTrip,
    );
    const kept = byRtt.slice(0, byRtt.length - OffsetTracker.TRIM_WORST);
    return median(kept.map((s) => s.offset));
  }

  clear(): void {
    this.window.length = 0;
  }
}
