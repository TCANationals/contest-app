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

  it('orders bottom-edge padding small ≤ medium ≤ large', () => {
    expect(OVERLAY_SCREEN_INSET_SMALL.BOTTOM_RIGHT_Y).toBeLessThanOrEqual(
      OVERLAY_SCREEN_INSET_MEDIUM.BOTTOM_RIGHT_Y,
    );
    expect(OVERLAY_SCREEN_INSET_MEDIUM.BOTTOM_RIGHT_Y).toBeLessThanOrEqual(
      OVERLAY_SCREEN_INSET_LARGE.BOTTOM_RIGHT_Y,
    );
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

  it('scales bottom-right padding by tier', () => {
    const small = overlayPaddingPx('bottomRight', 'small');
    const large = overlayPaddingPx('bottomRight', 'large');
    expect(small.paddingBottom).toBeLessThan(large.paddingBottom);
  });
});
