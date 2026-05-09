import { describe, expect, it } from 'vitest';

import {
  OVERLAY_COUNTDOWN_FONT_PX_MEDIUM,
  ancillaryBandMinPx,
  countdownFontSizePx,
  overlayTextSizeFromPrefs,
} from '../src/overlayTextSize';

describe('overlayTextSizeFromPrefs', () => {
  it('defaults invalid values to medium', () => {
    expect(overlayTextSizeFromPrefs(undefined)).toBe('medium');
    expect(overlayTextSizeFromPrefs('')).toBe('medium');
    expect(overlayTextSizeFromPrefs('huge')).toBe('medium');
  });

  it('accepts known tiers', () => {
    expect(overlayTextSizeFromPrefs('small')).toBe('small');
    expect(overlayTextSizeFromPrefs('large')).toBe('large');
  });
});

describe('countdownFontSizePx', () => {
  it('uses medium constant as the historical default size', () => {
    expect(countdownFontSizePx('medium')).toBe(OVERLAY_COUNTDOWN_FONT_PX_MEDIUM);
    expect(countdownFontSizePx('small')).toBeLessThan(OVERLAY_COUNTDOWN_FONT_PX_MEDIUM);
    expect(countdownFontSizePx('large')).toBeGreaterThan(OVERLAY_COUNTDOWN_FONT_PX_MEDIUM);
  });
});

describe('ancillaryBandMinPx', () => {
  it('orders small ≤ medium ≤ large', () => {
    expect(ancillaryBandMinPx('small')).toBeLessThanOrEqual(
      ancillaryBandMinPx('medium'),
    );
    expect(ancillaryBandMinPx('medium')).toBeLessThanOrEqual(
      ancillaryBandMinPx('large'),
    );
  });
});
