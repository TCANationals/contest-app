import type { CSSProperties } from 'react';

import {
  countdownStyle as sharedCountdownStyle,
  formatCountdown as sharedFormatCountdown,
  formatMs as sharedFormatMs,
} from '@tca-timer/shared';
import type {
  CountdownStyle,
  TimerStatus,
} from '@tca-timer/shared';

/**
 * Shared digit renderer for desktop overlay (§9.2.4) and projector
 * (§10.5).
 *
 * The color/border/pulse decision and the digit formatter both live
 * in `@tca-timer/shared` so the SPA and the contestant overlay can
 * never drift; this file is the SPA-side React layout that wraps
 * those pure functions with Tailwind classes and `8vw` responsive
 * sizing. The overlay does its own React layout for its fixed
 * 380×96 transparent window.
 *
 * The pure helpers below (`resolveCountdownStyle`, `formatCountdown`,
 * `formatMs`) are re-exported under their historical SPA names so
 * existing imports keep working — they're now thin aliases to the
 * shared module.
 */

export type { CountdownStyle };

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

/**
 * @deprecated Prefer `countdownStyle` from `@tca-timer/shared`. The
 * old SPA name is kept here so existing imports keep compiling, but
 * new code should consume the shared symbol directly.
 */
export const resolveCountdownStyle = sharedCountdownStyle;

/**
 * @deprecated Prefer `formatCountdown` from `@tca-timer/shared`.
 */
export const formatCountdown = sharedFormatCountdown;

/**
 * @deprecated Prefer `formatMs` from `@tca-timer/shared`.
 */
export const formatMs = sharedFormatMs;

export function CountdownWithBorder({
  status,
  remainingMs,
  flash = false,
  fontSize = '8vw',
  strokeWidthPx = 2,
  className,
  style,
}: CountdownWithBorderProps) {
  const { color, outline, pulse } = sharedCountdownStyle(status, remainingMs);
  const text = sharedFormatCountdown(status, remainingMs);

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
  // The idle "--:--" glyphs are thin dashes; applying the same 2 px stroke as
  // the running digits paints them as solid blobs. Skip the stroke in that
  // state since readability isn't a concern on the neutral idle background.
  const skipStroke = status === 'idle';

  return (
    <span
      className={classes}
      style={{
        color,
        fontSize,
        // Paint-order keeps the fill readable atop the stroke.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        paintOrder: 'stroke fill' as any,
        WebkitTextStroke: skipStroke ? 'none' : `${strokeWidthPx}px ${outline}`,
        ...style,
      }}
      aria-label={`Timer ${status}`}
    >
      {text}
    </span>
  );
}
