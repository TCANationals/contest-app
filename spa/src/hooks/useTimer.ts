import { useEffect, useState } from 'react';

import { useAppStore } from '../store';
import type { OffsetSample, TimerState } from '../store/types';

/**
 * Pure helper — remaining ms (§6.3). Spec formula:
 *
 *   paused  → state.remainingMs
 *   idle    → 0
 *   running → max(0, endsAtServerMs - (Date.now() + activeOffsetMs))
 */
export function computeRemainingMs(
  state: TimerState,
  activeOffsetMs: number,
  now: number = Date.now(),
): number {
  if (state.status === 'paused') return state.remainingMs ?? 0;
  if (state.status === 'idle') return 0;
  if (state.endsAtServerMs == null) return 0;
  const serverNow = now + activeOffsetMs;
  return Math.max(0, state.endsAtServerMs - serverNow);
}

/**
 * Sliding-median offset tracker (§6.3).
 *
 * Keeps the last 8 samples, drops the 2 with the largest round-trip, then
 * returns the median offset of the remaining 6.
 */
export class OffsetTracker {
  private samples: OffsetSample[] = [];
  private readonly windowSize = 8;

  /**
   * Adds a sample computed from a PONG frame.
   * Standard NTP-style formulas:
   *   roundTrip = (t3 - t0) - (t2 - t1)
   *   offset    = ((t1 - t0) + (t2 - t3)) / 2
   */
  addSample(t0: number, t1: number, t2: number, t3: number): void {
    const roundTrip = t3 - t0 - (t2 - t1);
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    this.samples.push({ roundTrip, offset });
    if (this.samples.length > this.windowSize) {
      this.samples.splice(0, this.samples.length - this.windowSize);
    }
  }

  /** Current active offset per §6.3 (median-of-6 after dropping 2 worst RTTs). */
  getActiveOffset(): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a.roundTrip - b.roundTrip);
    // Drop the 2 worst if we have a full window; otherwise use what we have.
    const kept = sorted.length >= this.windowSize
      ? sorted.slice(0, sorted.length - 2)
      : sorted;
    const offsets = kept.map((s) => s.offset).sort((a, b) => a - b);
    const mid = offsets.length >> 1;
    if (offsets.length === 0) return 0;
    return offsets.length % 2 === 1
      ? (offsets[mid] as number)
      : ((offsets[mid - 1] as number) + (offsets[mid] as number)) / 2;
  }

  /** Visible for testing. */
  get sampleCount(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * React hook: renders at 4 Hz (§6.3) and returns the current remaining ms
 * along with the underlying TimerState for convenience.
 */
export function useRemainingMs(): number {
  const timer = useAppStore((s) => s.timer);
  const activeOffsetMs = useAppStore((s) => s.activeOffsetMs);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => (n + 1) & 0xffff), 250);
    return () => window.clearInterval(id);
  }, []);

  if (!timer) return 0;
  return computeRemainingMs(timer, activeOffsetMs);
}
