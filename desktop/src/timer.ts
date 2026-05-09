// §6.3 / §6.5: render-side timer math. Pure functions so the full
// logic is covered by vitest without needing a Tauri / WS harness.
//
// `computeRemainingMs` and §9.5.1 alarm helpers live in
// `@tca-timer/shared` so the SPA and overlay stay aligned; §9.5.2 flash
// stays here (overlay-only preferences).

import type { TimerState } from './types';

export {
  alarmBaselineKey,
  computeRemainingMs,
  shouldFireAlarm,
  type AlarmDecisionInput,
} from '@tca-timer/shared';

/**
 * §9.5.2 configurable flash. Flashes when running AND remaining time is
 * strictly positive and at or below `thresholdSeconds` (stored in
 * preferences as seconds). At 00:00 the stroke flash stops so the display
 * stays steady after time expires.
 * Flash state is independent of the color pulse that §9.2 specifies for
 * sub-minute time.
 */
export function shouldFlash(
  status: TimerState['status'],
  remainingMs: number,
  enabled: boolean,
  thresholdSeconds: number,
): boolean {
  if (!enabled) return false;
  if (status !== 'running') return false;
  if (remainingMs <= 0) return false;
  const thresholdMs = thresholdSeconds * 1000;
  return remainingMs <= thresholdMs;
}
