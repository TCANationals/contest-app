// TODO(§6.3, §6.5): offset tracking via sliding-median of last 8 samples,
// computeRemainingMs rendered at 4 Hz / displayed at 1 Hz.

import type { TimerState } from '../store/types';

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
