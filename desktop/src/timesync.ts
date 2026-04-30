// §6.3 time-sync: median-of-6 offset tracker built from a sliding
// window of 8 (roundTrip, offset) samples.
//
// This module has no DOM or WS dependencies so it is trivially testable.

export interface PingSample {
  roundTrip: number;
  offset: number;
}

/**
 * Compute a single sample from the four clock readings that frame a
 * PING/PONG exchange:
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
): PingSample {
  return {
    roundTrip: t3 - t0 - (t2 - t1),
    offset: (t1 - t0 + (t2 - t3)) / 2,
  };
}

/**
 * Return the median of `values` (mid-value for odd length, mean of two
 * middles for even length). Does not mutate input.
 */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  if (n % 2 === 1) return sorted[(n - 1) >> 1]!;
  return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/**
 * Maintain a sliding window of the last 8 samples. The active offset is
 * the median of the remaining 6 after dropping the 2 largest-RTT samples.
 * Until 3 samples have arrived, the plain median of what is available is
 * returned (so the warm-up burst can still produce a reasonable offset).
 */
export class OffsetTracker {
  private readonly window: PingSample[] = [];
  private readonly capacity = 8;
  private readonly trimWorst = 2;

  push(sample: PingSample): void {
    this.window.push(sample);
    if (this.window.length > this.capacity) {
      this.window.shift();
    }
  }

  /** Number of samples currently held. */
  size(): number {
    return this.window.length;
  }

  /**
   * Median offset after trimming, in ms. Returns `null` if there are no
   * samples yet.
   */
  activeOffsetMs(): number | null {
    if (this.window.length === 0) return null;
    if (this.window.length <= this.trimWorst) {
      return median(this.window.map((s) => s.offset));
    }
    const byRtt = [...this.window].sort(
      (a, b) => a.roundTrip - b.roundTrip,
    );
    const kept = byRtt.slice(0, byRtt.length - this.trimWorst);
    return median(kept.map((s) => s.offset));
  }

  clear(): void {
    this.window.length = 0;
  }
}
