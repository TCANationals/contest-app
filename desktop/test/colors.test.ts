import { describe, it, expect } from 'vitest';

import { countdownStyle } from '../src/colors';

describe('countdownStyle', () => {
  it('uses idle gray with black border when idle', () => {
    const s = countdownStyle('idle', null);
    expect(s.color).toBe('#888888');
    expect(s.border).toBe('#000000');
    expect(s.pulse).toBe(false);
  });

  it('uses white with black border when paused', () => {
    const s = countdownStyle('paused', 12_000);
    expect(s.color).toBe('#FFFFFF');
    expect(s.border).toBe('#000000');
    expect(s.pulse).toBe(false);
  });

  it('uses green with black border above 5 minutes', () => {
    const s = countdownStyle('running', 5 * 60_000 + 1);
    expect(s.color).toBe('#16A34A');
    expect(s.border).toBe('#000000');
    expect(s.pulse).toBe(false);
  });

  it('uses amber with dark navy border in the 1-5 minute band', () => {
    const s = countdownStyle('running', 4 * 60_000);
    expect(s.color).toBe('#F59E0B');
    expect(s.border).toBe('#1A1A2E');
    expect(s.pulse).toBe(false);
  });

  it('uses amber at exactly 5 minutes (inclusive upper bound)', () => {
    const s = countdownStyle('running', 5 * 60_000);
    expect(s.color).toBe('#F59E0B');
  });

  it('uses red with white border and pulse below 1 minute', () => {
    const s = countdownStyle('running', 30_000);
    expect(s.color).toBe('#DC2626');
    expect(s.border).toBe('#FFFFFF');
    expect(s.pulse).toBe(true);
  });

  it('remains red-pulsing at 0', () => {
    const s = countdownStyle('running', 0);
    expect(s.color).toBe('#DC2626');
    expect(s.pulse).toBe(true);
  });
});
