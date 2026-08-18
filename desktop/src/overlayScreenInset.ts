import type { OverlayTextSize } from './overlayTextSize';
import type { PositionCorner } from './types';

/**
 * In-window padding in CSS px. Native screen placement is handled separately
 * by `overlay_screen_inset` in `src-tauri/src/main.rs`; on Linux that layer
 * applies per-tier bottom compensation while these bottom values remain zero.
 *
 * Three tiers follow `display.textSize`. Edit these tables to tune offsets.
 *
 * Horizontal = padding toward the anchored **left** or **right** edge of
 * the window; vertical = toward **top** or **bottom** (only the two edges
 * at the chosen corner are non-zero).
 */
export const OVERLAY_SCREEN_INSET_SMALL = {
  TOP_LEFT_X: 0,
  TOP_LEFT_Y: 4,
  TOP_RIGHT_X: 0,
  TOP_RIGHT_Y: 4,
  BOTTOM_LEFT_X: 0,
  BOTTOM_LEFT_Y: 0,
  BOTTOM_RIGHT_X: 0,
  BOTTOM_RIGHT_Y: 0,
} as const;

/** Matches `overlay_screen_inset::MEDIUM` (default tray tier). */
export const OVERLAY_SCREEN_INSET_MEDIUM = {
  TOP_LEFT_X: 0,
  TOP_LEFT_Y: 5,
  TOP_RIGHT_X: 0,
  TOP_RIGHT_Y: 5,
  BOTTOM_LEFT_X: 0,
  BOTTOM_LEFT_Y: 0,
  BOTTOM_RIGHT_X: 0,
  BOTTOM_RIGHT_Y: 0,
} as const;

export const OVERLAY_SCREEN_INSET_LARGE = {
  TOP_LEFT_X: 0,
  TOP_LEFT_Y: 12,
  TOP_RIGHT_X: 0,
  TOP_RIGHT_Y: 0,
  BOTTOM_LEFT_X: 0,
  BOTTOM_LEFT_Y: 0,
  BOTTOM_RIGHT_X: 0,
  BOTTOM_RIGHT_Y: 0,
} as const;

export type OverlayScreenInsetTable = {
  readonly TOP_LEFT_X: number;
  readonly TOP_LEFT_Y: number;
  readonly TOP_RIGHT_X: number;
  readonly TOP_RIGHT_Y: number;
  readonly BOTTOM_LEFT_X: number;
  readonly BOTTOM_LEFT_Y: number;
  readonly BOTTOM_RIGHT_X: number;
  readonly BOTTOM_RIGHT_Y: number;
};

export function overlayScreenInsetForTextSize(
  size: OverlayTextSize,
): OverlayScreenInsetTable {
  switch (size) {
    case 'small':
      return OVERLAY_SCREEN_INSET_SMALL;
    case 'large':
      return OVERLAY_SCREEN_INSET_LARGE;
    default:
      return OVERLAY_SCREEN_INSET_MEDIUM;
  }
}

/**
 * Linux shifts bottom-anchored content to account for WebView whitespace and
 * glyph bearings, making its visible bottom gap match the visible side gap.
 * Mutter clamps negative native offsets, so Small and Medium are corrected
 * inside the WebView; Large retains a small native offset.
 */
export function bottomContentCompensationPx(
  corner: PositionCorner,
  textSize: OverlayTextSize,
  isLinux: boolean,
): number {
  const isBottom = corner === 'bottomLeft' || corner === 'bottomRight';
  if (!isLinux || !isBottom) return 0;

  switch (textSize) {
    case 'small':
      return 30;
    case 'medium':
      return 11;
    default:
      return 0;
  }
}

export function overlayPaddingPx(
  corner: PositionCorner,
  textSize: OverlayTextSize,
): {
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
} {
  const INSET = overlayScreenInsetForTextSize(textSize);
  switch (corner) {
    case 'topLeft':
      return {
        paddingTop: INSET.TOP_LEFT_Y,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: INSET.TOP_LEFT_X,
      };
    case 'topRight':
      return {
        paddingTop: INSET.TOP_RIGHT_Y,
        paddingRight: INSET.TOP_RIGHT_X,
        paddingBottom: 0,
        paddingLeft: 0,
      };
    case 'bottomLeft':
      return {
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: INSET.BOTTOM_LEFT_Y,
        paddingLeft: INSET.BOTTOM_LEFT_X,
      };
    case 'bottomRight':
      return {
        paddingTop: 0,
        paddingRight: INSET.BOTTOM_RIGHT_X,
        paddingBottom: INSET.BOTTOM_RIGHT_Y,
        paddingLeft: 0,
      };
    default: {
      const _exhaustive: never = corner;
      return _exhaustive;
    }
  }
}
