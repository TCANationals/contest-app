import type { TimerStatus } from './types';

/**
 * Format a non-negative ms duration as `MM:SS` (under an hour) or
 * `H:MM:SS` (one hour or more). Sub-second remainders round DOWN to
 * the next whole second, matching the §9.5.1 alarm boundary
 * (alarm fires once `remainingMs` first crosses 0). Negative inputs
 * clamp to `00:00`.
 */
export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Pick the human-readable countdown string for a (status, remaining)
 * pair. Idle always reads `--:--`; paused / running format their
 * `remainingMs` (a `null` running remaining defensively reads
 * `--:--` as well).
 */
export function formatCountdown(
  status: TimerStatus,
  remainingMs: number | null,
): string {
  if (status === 'idle' || remainingMs == null) return '--:--';
  return formatMs(remainingMs);
}
