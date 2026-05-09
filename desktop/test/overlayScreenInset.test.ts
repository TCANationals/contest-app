import { describe, it, expect } from 'vitest';

import {
  OVERLAY_SCREEN_INSET,
  overlayPaddingPx,
} from '../src/overlayScreenInset';

describe('overlayPaddingPx', () => {
  it('applies top-left insets on top and left only', () => {
    expect(overlayPaddingPx('topLeft')).toEqual({
      paddingTop: OVERLAY_SCREEN_INSET.TOP_LEFT_Y,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: OVERLAY_SCREEN_INSET.TOP_LEFT_X,
    });
  });

  it('applies bottom-right insets on bottom and right only', () => {
    expect(overlayPaddingPx('bottomRight')).toEqual({
      paddingTop: 0,
      paddingRight: OVERLAY_SCREEN_INSET.BOTTOM_RIGHT_X,
      paddingBottom: OVERLAY_SCREEN_INSET.BOTTOM_RIGHT_Y,
      paddingLeft: 0,
    });
  });
});
