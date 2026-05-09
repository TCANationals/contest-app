import type { PositionCorner } from './types';

/**
 * In-window padding that mirrors `overlay_screen_inset` in
 * `src-tauri/src/main.rs`. Values are **logical px** (same numbers as
 * Rust); Tauri scales window placement by DPI, the WebView uses CSS px.
 *
 * Each corner applies inset only on the two edges that meet at the
 * anchored corner so content stays tight to the same corner as the shell.
 */
export const OVERLAY_SCREEN_INSET = {
  TOP_LEFT_X: 0,
  TOP_LEFT_Y: 7,
  TOP_RIGHT_X: 0,
  TOP_RIGHT_Y: 7,
  BOTTOM_LEFT_X: 0,
  BOTTOM_LEFT_Y: 35,
  BOTTOM_RIGHT_X: 0,
  BOTTOM_RIGHT_Y: 35,
} as const;

export function overlayPaddingPx(corner: PositionCorner): {
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
} {
  switch (corner) {
    case 'topLeft':
      return {
        paddingTop: OVERLAY_SCREEN_INSET.TOP_LEFT_Y,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: OVERLAY_SCREEN_INSET.TOP_LEFT_X,
      };
    case 'topRight':
      return {
        paddingTop: OVERLAY_SCREEN_INSET.TOP_RIGHT_Y,
        paddingRight: OVERLAY_SCREEN_INSET.TOP_RIGHT_X,
        paddingBottom: 0,
        paddingLeft: 0,
      };
    case 'bottomLeft':
      return {
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: OVERLAY_SCREEN_INSET.BOTTOM_LEFT_Y,
        paddingLeft: OVERLAY_SCREEN_INSET.BOTTOM_LEFT_X,
      };
    case 'bottomRight':
      return {
        paddingTop: 0,
        paddingRight: OVERLAY_SCREEN_INSET.BOTTOM_RIGHT_X,
        paddingBottom: OVERLAY_SCREEN_INSET.BOTTOM_RIGHT_Y,
        paddingLeft: 0,
      };
    default: {
      const _exhaustive: never = corner;
      return _exhaustive;
    }
  }
}
