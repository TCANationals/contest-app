import { describe, expect, it } from 'vitest';

import { countdownStyle } from '../src/colors';

describe('countdownStyle', () => {
  it('uses idle gray with black outline when idle', () => {
    const s = countdownStyle('idle', null);
    expect(s.color).toBe('#888888');
    expect(s.outline).toBe('#000000');
    expect(s.pulse).toBe(false);
  });

  it('uses white with black outline when paused', () => {
    const s = countdownStyle('paused', 12_000);
    expect(s.color).toBe('#FFFFFF');
    expect(s.outline).toBe('#000000');
    expect(s.pulse).toBe(false);
  });

  it('uses green with black outline above 5 minutes', () => {
    const s = countdownStyle('running', 5 * 60_000 + 1);
    expect(s.color).toBe('#16A34A');
    expect(s.outline).toBe('#000000');
    expect(s.pulse).toBe(false);
  });

  it('uses amber with dark navy outline in the 1-5 minute band', () => {
    const s = countdownStyle('running', 4 * 60_000);
    expect(s.color).toBe('#F59E0B');
    expect(s.outline).toBe('#1A1A2E');
    expect(s.pulse).toBe(false);
  });

  it('uses amber at exactly 5 minutes (inclusive upper bound)', () => {
    const s = countdownStyle('running', 5 * 60_000);
    expect(s.color).toBe('#F59E0B');
  });

  it('uses red with white outline and pulse below 1 minute', () => {
    const s = countdownStyle('running', 30_000);
    expect(s.color).toBe('#DC2626');
    expect(s.outline).toBe('#FFFFFF');
    expect(s.pulse).toBe(true);
  });

  it('stays red but stops pulsing once the countdown hits zero', () => {
    const s = countdownStyle('running', 0);
    expect(s.color).toBe('#DC2626');
    expect(s.pulse).toBe(false);
  });

  it('does not pulse below zero either (overshoot guard)', () => {
    const s = countdownStyle('running', -250);
    expect(s.color).toBe('#DC2626');
    expect(s.pulse).toBe(false);
  });

  it('still pulses just above zero', () => {
    const s = countdownStyle('running', 1);
    expect(s.color).toBe('#DC2626');
    expect(s.pulse).toBe(true);
  });

  it('treats null remainingMs as 0 when running (no pulse, defensive)', () => {
    const s = countdownStyle('running', null);
    expect(s.color).toBe('#DC2626');
    expect(s.pulse).toBe(false);
  });
});
