import type { TimerState } from './types';

/**
 * Compute the timer's currently-remaining ms (§6.3 / §6.5) at the
 * caller's wall clock, accounting for the time-sync offset between
 * the client and the server.
 *
 * * `idle`    → 0 (no timer is set)
 * * `paused`  → `state.remainingMs` (server-side snapshot at pause time)
 * * `running` → `endsAtServerMs - (now + activeOffsetMs)`, clamped to ≥ 0
 *
 * The server NEVER streams "current remaining time" while running;
 * it streams `endsAtServerMs` and we recompute locally so each
 * client renders smoothly against its own monotonic clock without
 * waiting for further frames. `activeOffsetMs` is the median offset
 * from the §6.3 tracker — pass `0` if no offset tracking is in use.
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
