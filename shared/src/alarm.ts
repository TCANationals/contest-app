import type { TimerState } from './types';

/**
 * Path served from each app’s Vite `public/` folder (`ding.mp3` in both
 * `spa/` and `desktop/`).
 */
export const END_TIMER_ALARM_ASSET_PATH = '/ding.mp3';

/**
 * Identifies the server-authored timer session for §9.5.1 alarm edge
 * detection. When this is unchanged, repeated STATE frames are the same
 * logical timer — consumers must not reset `previousRemainingMs` just
 * because a new JSON object arrived, or the expiry crossing is missed
 * when the server already reports `remainingMs === 0` locally.
 */
export function alarmBaselineKey(state: TimerState): string {
  return `${state.room}\0${state.version}\0${state.status}\0${
    state.endsAtServerMs ?? ''
  }\0${state.remainingMs ?? ''}`;
}

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
