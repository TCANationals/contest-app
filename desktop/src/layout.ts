import type { PositionCorner } from './types';

/**
 * Map a screen corner to the flex alignment + text-align triple that
 * anchors the overlay's content to the *same* corner of the 380×96
 * overlay window.
 *
 * The Tauri host (`apply_corner` in `src-tauri/src/main.rs`) pins the
 * window itself `EDGE_MARGIN` (24px) away from the named screen
 * corner. Without this helper the contents flex-centred inside the
 * window, leaving the digits visually floating ~tens of pixels inside
 * the screen corner — looking misaligned. Mirroring the window's
 * screen anchor inside the window puts the digits right where the
 * eye expects them: tight against the same corner the user picked.
 *
 * Corner → in-window alignment:
 *   topLeft     → flex-start / flex-start / left
 *   topRight    → flex-end   / flex-start / right
 *   bottomLeft  → flex-start / flex-end   / left
 *   bottomRight → flex-end   / flex-end   / right
 */
export interface CornerLayout {
  /** flex `align-items` along the cross (horizontal) axis. */
  alignItems: 'flex-start' | 'flex-end' | 'center';
  /** flex `justify-content` along the main (vertical) axis. */
  justifyContent: 'flex-start' | 'flex-end' | 'center';
  /** Text alignment for inline content (the message line wraps). */
  textAlign: 'left' | 'right' | 'center';
}

export function layoutForCorner(corner: PositionCorner): CornerLayout {
  switch (corner) {
    case 'topLeft':
      return { alignItems: 'flex-start', justifyContent: 'flex-start', textAlign: 'left' };
    case 'topRight':
      return { alignItems: 'flex-end', justifyContent: 'flex-start', textAlign: 'right' };
    case 'bottomLeft':
      return { alignItems: 'flex-start', justifyContent: 'flex-end', textAlign: 'left' };
    case 'bottomRight':
      return { alignItems: 'flex-end', justifyContent: 'flex-end', textAlign: 'right' };
    default:
      // Defensive fallback for any future or malformed value coming
      // off the Tauri event bus — keep the legacy centred layout so
      // the overlay still renders, just without corner-specific
      // anchoring.
      return { alignItems: 'center', justifyContent: 'center', textAlign: 'center' };
  }
}
