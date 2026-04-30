// Countdown color priorities and contrast borders per §9.2.

import type { TimerStatus } from './types';

export interface CountdownStyle {
  /** Fill color of the digits. */
  color: string;
  /** Stroke color for the high-contrast outline. */
  border: string;
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

export function countdownStyle(
  status: TimerStatus,
  remainingMs: number | null,
): CountdownStyle {
  if (status === 'idle') {
    return { color: PALETTE.idleGray, border: PALETTE.black, pulse: false };
  }
  if (status === 'paused') {
    return { color: PALETTE.pausedWhite, border: PALETTE.black, pulse: false };
  }
  const rem = remainingMs ?? 0;
  if (rem < 60_000) {
    return { color: PALETTE.red, border: PALETTE.white, pulse: true };
  }
  if (rem <= 5 * 60_000) {
    return { color: PALETTE.amber, border: PALETTE.darkNavy, pulse: false };
  }
  return { color: PALETTE.green, border: PALETTE.black, pulse: false };
}
