// §6.3 / §6.5: render-side timer math. Pure functions so the full
// logic is covered by vitest without needing a Tauri / WS harness.
//
// `computeRemainingMs` lives in `@tca-timer/shared` so the SPA and
// the overlay render identically against the same time-sync math;
// the alarm and flash decisions below are overlay-specific (§9.5)
// and stay here.

import type { TimerState } from './types';

export { computeRemainingMs } from '@tca-timer/shared';

export interface AlarmDecisionInput {
  status: TimerState['status'];
  remainingMs: number;
  previousRemainingMs: number;
  lastFiredAt: number | null;
  now: number;
  /** Alarm enabled toggle (§9.5.1). */
  enabled: boolean;
}

/**
 * §9.5.1 end-of-timer alarm gate. Returns `true` on the render tick where
 * `running` remaining crosses into 0 for the first time, suppressing
 * re-fires within 30s of the previous fire.
 */
export function shouldFireAlarm(input: AlarmDecisionInput): boolean {
  if (!input.enabled) return false;
  if (input.status !== 'running') return false;
  if (input.remainingMs > 0) return false;
  if (input.previousRemainingMs <= 0) return false;
  if (
    input.lastFiredAt != null &&
    input.now - input.lastFiredAt < 30_000
  ) {
    return false;
  }
  return true;
}

/**
 * §9.5.2 configurable flash. Flashes when running AND under the
 * configured threshold. Flash state is independent of the color pulse
 * that §9.2 specifies for sub-minute time.
 */
export function shouldFlash(
  status: TimerState['status'],
  remainingMs: number,
  enabled: boolean,
  thresholdMinutes: number,
): boolean {
  if (!enabled) return false;
  if (status !== 'running') return false;
  const thresholdMs = thresholdMinutes * 60_000;
  // §9.5.2 is explicit: "remaining time ≤ thresholdMinutes * 60_000 ms
  // while running". `≤` (inclusive) is the contractual boundary; the
  // exact 2:00.000 tick at which flashing begins is negligible at
  // render cadence but matches the spec verbatim.
  return remainingMs <= thresholdMs;
}
