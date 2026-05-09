/**
 * Countdown / overlay typography tiers (tray `display.textSize`).
 * Edit these constants to tune sizing — Rust prefs store small | medium | large only.
 */

export type OverlayTextSize = 'small' | 'medium' | 'large';

/** Main monospace countdown (`data-testid="countdown"`). */
export const OVERLAY_COUNTDOWN_FONT_PX_SMALL = 30;
export const OVERLAY_COUNTDOWN_FONT_PX_MEDIUM = 48;
export const OVERLAY_COUNTDOWN_FONT_PX_LARGE = 64;

/** `-webkit-text-stroke` width for countdown digits. */
export const OVERLAY_COUNTDOWN_STROKE_PX_SMALL = 1;
export const OVERLAY_COUNTDOWN_STROKE_PX_MEDIUM = 1.5;
export const OVERLAY_COUNTDOWN_STROKE_PX_LARGE = 2;

/** Reserved band beside countdown (paused / message slot `minHeight`). */
export const OVERLAY_ANCILLARY_BAND_MIN_PX_SMALL = 19
export const OVERLAY_ANCILLARY_BAND_MIN_PX_MEDIUM = 22;
export const OVERLAY_ANCILLARY_BAND_MIN_PX_LARGE = 27;

/** PAUSED label inside the ancillary chip. */
export const OVERLAY_PAUSED_FONT_PX_SMALL = 9;
export const OVERLAY_PAUSED_FONT_PX_MEDIUM = 12;
export const OVERLAY_PAUSED_FONT_PX_LARGE = 16;

/** Judge message line in the ancillary chip. */
export const OVERLAY_BANNER_FONT_PX_SMALL = 9;
export const OVERLAY_BANNER_FONT_PX_MEDIUM = 12;
export const OVERLAY_BANNER_FONT_PX_LARGE = 16;

export function overlayTextSizeFromPrefs(
  raw: string | undefined,
): OverlayTextSize {
  if (raw === 'small' || raw === 'medium' || raw === 'large') {
    return raw;
  }
  return 'medium';
}

export function countdownFontSizePx(size: OverlayTextSize): number {
  switch (size) {
    case 'small':
      return OVERLAY_COUNTDOWN_FONT_PX_SMALL;
    case 'large':
      return OVERLAY_COUNTDOWN_FONT_PX_LARGE;
    default:
      return OVERLAY_COUNTDOWN_FONT_PX_MEDIUM;
  }
}

export function countdownStrokePx(size: OverlayTextSize): number {
  switch (size) {
    case 'small':
      return OVERLAY_COUNTDOWN_STROKE_PX_SMALL;
    case 'large':
      return OVERLAY_COUNTDOWN_STROKE_PX_LARGE;
    default:
      return OVERLAY_COUNTDOWN_STROKE_PX_MEDIUM;
  }
}

export function ancillaryBandMinPx(size: OverlayTextSize): number {
  switch (size) {
    case 'small':
      return OVERLAY_ANCILLARY_BAND_MIN_PX_SMALL;
    case 'large':
      return OVERLAY_ANCILLARY_BAND_MIN_PX_LARGE;
    default:
      return OVERLAY_ANCILLARY_BAND_MIN_PX_MEDIUM;
  }
}

export function pausedLabelFontPx(size: OverlayTextSize): number {
  switch (size) {
    case 'small':
      return OVERLAY_PAUSED_FONT_PX_SMALL;
    case 'large':
      return OVERLAY_PAUSED_FONT_PX_LARGE;
    default:
      return OVERLAY_PAUSED_FONT_PX_MEDIUM;
  }
}

export function bannerMessageFontPx(size: OverlayTextSize): number {
  switch (size) {
    case 'small':
      return OVERLAY_BANNER_FONT_PX_SMALL;
    case 'large':
      return OVERLAY_BANNER_FONT_PX_LARGE;
    default:
      return OVERLAY_BANNER_FONT_PX_MEDIUM;
  }
}
