// Public surface of `@tca-timer/shared`. Both consumers (`desktop/`
// overlay and `spa/`) import from this barrel so adding a new shared
// helper only requires re-exporting it here.

export {
  alarmBaselineKey,
  shouldFireAlarm,
  END_TIMER_ALARM_ASSET_PATH,
  type AlarmDecisionInput,
} from './alarm';
export { computeRemainingMs } from './compute';
export { formatCountdown, formatMs } from './format';
export { countdownStyle, NEUTRAL_COUNTDOWN_STYLE } from './colors';
export type { CountdownStyle } from './colors';
export { OffsetTracker, computeSample, median } from './timesync';
export type { OffsetSample, TimerState, TimerStatus } from './types';
