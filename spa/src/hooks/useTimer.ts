import { useEffect, useState } from 'react';

import { useAppStore } from '../store';
import {
  computeRemainingMs as sharedComputeRemainingMs,
  OffsetTracker as SharedOffsetTracker,
} from '@tca-timer/shared';

/**
 * Pure helper — remaining ms (§6.3). Re-exported from
 * `@tca-timer/shared` so the SPA and the contestant overlay never
 * drift on this calculation; existing SPA callsites keep importing
 * from `useTimer` without churn.
 */
export const computeRemainingMs = sharedComputeRemainingMs;

/**
 * Sliding-median offset tracker (§6.3) — thin SPA-side facade over
 * the shared `OffsetTracker`. Preserves the SPA's historical
 * `addSample` / `getActiveOffset` / `sampleCount` / `reset` API so
 * existing code (and the offsetTracker tests) keep working without
 * a rename. The actual storage + trimming logic lives once, in the
 * shared package.
 */
export class OffsetTracker {
  private readonly inner = new SharedOffsetTracker();

  /**
   * Adds a sample computed from a PONG frame. NTP-style formulas:
   *   roundTrip = (t3 - t0) - (t2 - t1)
   *   offset    = ((t1 - t0) + (t2 - t3)) / 2
   */
  addSample(t0: number, t1: number, t2: number, t3: number): void {
    this.inner.pushFromTimestamps(t0, t1, t2, t3);
  }

  /**
   * Current active offset per §6.3 (median-of-6 after dropping 2
   * worst RTTs). Returns `0` when no samples have arrived yet (the
   * shared layer returns `null`, which the SPA's existing callers
   * don't expect).
   */
  getActiveOffset(): number {
    return this.inner.activeOffsetMs() ?? 0;
  }

  /** Visible for testing. */
  get sampleCount(): number {
    return this.inner.size();
  }

  reset(): void {
    this.inner.clear();
  }
}

/**
 * React hook: renders at 4 Hz (§6.3) and returns the current
 * remaining ms along with the underlying TimerState for convenience.
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
