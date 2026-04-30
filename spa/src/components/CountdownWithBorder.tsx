import type { CSSProperties } from 'react';

import type { TimerStatus } from '../store/types';

/**
 * Shared digit renderer for desktop overlay (§9.2.4) and projector (§10.5).
 *
 * Color states (§9.2 priorities):
 *   idle                      → gray (#888), "--:--" text
 *   paused                    → white, "PAUSED" pill beneath
 *   running > 5 minutes       → green (#16A34A)
 *   running 1–5 minutes       → amber (#F59E0B)
 *   running < 1 minute        → red (#DC2626) + 1 Hz pulse
 *
 * Each color pairs with an inverse-color outline ≥ 2 px (§9.2 contrast border).
 */

export interface CountdownStyle {
  color: string;
  outline: string;
  pulse: boolean;
}

export interface CountdownWithBorderProps {
  status: TimerStatus;
  remainingMs: number | null;
  /** Optional: force a flashing animation (§9.5.2). */
  flash?: boolean;
  /** Font size expressed as css units (e.g. '8vw'). */
  fontSize?: string;
  /** Stroke width; default 2 px. */
  strokeWidthPx?: number;
  /** When true, idle status still renders digits if remainingMs is provided. */
  className?: string;
  style?: CSSProperties;
}

export function resolveCountdownStyle(
  status: TimerStatus,
  remainingMs: number | null,
): CountdownStyle {
  if (status === 'idle') {
    return { color: '#888888', outline: '#000000', pulse: false };
  }
  if (status === 'paused') {
    return { color: '#FFFFFF', outline: '#000000', pulse: false };
  }
  // running
  const ms = remainingMs ?? 0;
  if (ms < 60_000) {
    return { color: '#DC2626', outline: '#FFFFFF', pulse: true };
  }
  if (ms <= 5 * 60_000) {
    return { color: '#F59E0B', outline: '#1A1A2E', pulse: false };
  }
  return { color: '#16A34A', outline: '#000000', pulse: false };
}

export function formatCountdown(
  status: TimerStatus,
  remainingMs: number | null,
): string {
  if (status === 'idle' || remainingMs == null) return '--:--';
  return formatMs(remainingMs);
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function CountdownWithBorder({
  status,
  remainingMs,
  flash = false,
  fontSize = '8vw',
  strokeWidthPx = 2,
  className,
  style,
}: CountdownWithBorderProps) {
  const { color, outline, pulse } = resolveCountdownStyle(status, remainingMs);
  const text = formatCountdown(status, remainingMs);

  const classes = [
    'font-mono',
    'font-bold',
    'tabular-nums',
    'leading-none',
    'select-none',
    pulse ? 'tca-pulse' : '',
    flash ? 'tca-flash' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  // WebkitTextStroke is the widely-supported way to outline glyphs without a box border.
  return (
    <span
      className={classes}
      style={{
        color,
        fontSize,
        // Paint-order keeps the fill readable atop the stroke.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        paintOrder: 'stroke fill' as any,
        WebkitTextStroke: `${strokeWidthPx}px ${outline}`,
        ...style,
      }}
      aria-label={`Timer ${status}`}
    >
      {text}
    </span>
  );
}
