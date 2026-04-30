import type { TimerStatus } from './types';

/**
 * Resolved style for the countdown digits at a given timer state.
 *
 * The exact hex values come from the §9.2.4 / §10.5 priority tables,
 * which both consumer apps must implement identically. Centralising
 * them here means any future palette tweak only has to land in one
 * place.
 *
 * `outline` is the high-contrast stroke color. The desktop overlay
 * historically called this field `border`; the SPA called it
 * `outline`. We standardise on `outline` here (CSS-aligned with
 * `WebkitTextStroke`) and the overlay wraps it locally if it still
 * needs the legacy name.
 */
export interface CountdownStyle {
  /** Fill color of the digits. */
  color: string;
  /** Stroke color for the high-contrast outline. */
  outline: string;
  /** 1 Hz pulse when `true` (under the final minute, §9.2). */
  pulse: boolean;
}

const PALETTE = {
  green: '#16A34A',
  amber: '#F59E0B',
  red: '#DC2626',
  idleGray: '#888888',
  pausedWhite: '#FFFFFF',
  black: '#000000',
  darkNavy: '#1A1A2E',
  white: '#FFFFFF',
} as const;

/**
 * Resolve the (color, outline, pulse) triple for the countdown digits
 * given the current `(status, remainingMs)`. Pure function; no DOM,
 * no Date.now(), no React.
 *
 * Priority (highest → lowest):
 *
 *   1. `idle`      → idle gray on black, no pulse
 *   2. `paused`    → white on black, no pulse
 *   3. `running` with `remainingMs < 60_000`     → red on white, pulsing
 *   4. `running` with `remainingMs ≤ 5 × 60_000` → amber on dark navy
 *   5. `running` otherwise                        → green on black
 */
export function countdownStyle(
  status: TimerStatus,
  remainingMs: number | null,
): CountdownStyle {
  if (status === 'idle') {
    return { color: PALETTE.idleGray, outline: PALETTE.black, pulse: false };
  }
  if (status === 'paused') {
    return { color: PALETTE.pausedWhite, outline: PALETTE.black, pulse: false };
  }
  const rem = remainingMs ?? 0;
  if (rem < 60_000) {
    return { color: PALETTE.red, outline: PALETTE.white, pulse: true };
  }
  if (rem <= 5 * 60_000) {
    return { color: PALETTE.amber, outline: PALETTE.darkNavy, pulse: false };
  }
  return { color: PALETTE.green, outline: PALETTE.black, pulse: false };
}
