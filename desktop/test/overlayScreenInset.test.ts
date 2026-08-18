import { describe, it, expect } from 'vitest';

import {
  OVERLAY_SCREEN_INSET_LARGE,
  OVERLAY_SCREEN_INSET_MEDIUM,
  OVERLAY_SCREEN_INSET_SMALL,
  overlayPaddingPx,
  overlayScreenInsetForTextSize,
} from '../src/overlayScreenInset';

describe('overlayScreenInsetForTextSize', () => {
  it('returns distinct tables per tier', () => {
    expect(overlayScreenInsetForTextSize('small')).toBe(
      OVERLAY_SCREEN_INSET_SMALL,
    );
    expect(overlayScreenInsetForTextSize('medium')).toBe(
      OVERLAY_SCREEN_INSET_MEDIUM,
    );
    expect(overlayScreenInsetForTextSize('large')).toBe(
      OVERLAY_SCREEN_INSET_LARGE,
    );
  });

  it('keeps every bottom position flush across text-size tiers', () => {
    for (const inset of [
      OVERLAY_SCREEN_INSET_SMALL,
      OVERLAY_SCREEN_INSET_MEDIUM,
      OVERLAY_SCREEN_INSET_LARGE,
    ]) {
      expect(inset.BOTTOM_LEFT_Y).toBe(0);
      expect(inset.BOTTOM_RIGHT_Y).toBe(0);
    }
  });
});

describe('overlayPaddingPx', () => {
  it('applies top-left insets on top and left only (medium)', () => {
    expect(overlayPaddingPx('topLeft', 'medium')).toEqual({
      paddingTop: OVERLAY_SCREEN_INSET_MEDIUM.TOP_LEFT_Y,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: OVERLAY_SCREEN_INSET_MEDIUM.TOP_LEFT_X,
    });
  });

  it('does not add in-window padding to bottom positions', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      expect(overlayPaddingPx('bottomLeft', size).paddingBottom).toBe(0);
      expect(overlayPaddingPx('bottomRight', size).paddingBottom).toBe(0);
    }
  });
});
