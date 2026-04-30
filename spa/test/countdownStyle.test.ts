import { describe, expect, it } from 'vitest';

import {
  formatCountdown,
  formatMs,
  resolveCountdownStyle,
} from '../src/components/CountdownWithBorder';

describe('resolveCountdownStyle', () => {
  it('idle → gray over black outline', () => {
    expect(resolveCountdownStyle('idle', null)).toEqual({
      color: '#888888',
      outline: '#000000',
      pulse: false,
    });
  });

  it('paused → white over black outline', () => {
    expect(resolveCountdownStyle('paused', 60_000)).toEqual({
      color: '#FFFFFF',
      outline: '#000000',
      pulse: false,
    });
  });

  it('running > 5 min → green over black outline, no pulse', () => {
    const s = resolveCountdownStyle('running', 5 * 60_000 + 1);
    expect(s.color).toBe('#16A34A');
    expect(s.outline).toBe('#000000');
    expect(s.pulse).toBe(false);
  });

  it('running 1–5 min → amber over navy outline', () => {
    const s = resolveCountdownStyle('running', 2 * 60_000);
    expect(s.color).toBe('#F59E0B');
    expect(s.outline).toBe('#1A1A2E');
    expect(s.pulse).toBe(false);
  });

  it('running < 1 min → red over white outline with pulse', () => {
    const s = resolveCountdownStyle('running', 30_000);
    expect(s.color).toBe('#DC2626');
    expect(s.outline).toBe('#FFFFFF');
    expect(s.pulse).toBe(true);
  });
});

describe('formatCountdown', () => {
  it('idle is always --:--', () => {
    expect(formatCountdown('idle', 30_000)).toBe('--:--');
    expect(formatCountdown('idle', null)).toBe('--:--');
  });

  it('paused shows remaining time', () => {
    expect(formatCountdown('paused', 125_000)).toBe('02:05');
  });

  it('running shows remaining time', () => {
    expect(formatCountdown('running', 9_000)).toBe('00:09');
  });
});

describe('formatMs', () => {
  it('MM:SS under an hour', () => {
    expect(formatMs(0)).toBe('00:00');
    expect(formatMs(59_500)).toBe('00:59');
    expect(formatMs(60_000)).toBe('01:00');
    expect(formatMs(3 * 60_000 + 9_000)).toBe('03:09');
  });

  it('H:MM:SS at or over an hour', () => {
    expect(formatMs(3_600_000)).toBe('1:00:00');
    expect(formatMs(2 * 3_600_000 + 3 * 60_000 + 5_000)).toBe('2:03:05');
  });

  it('clamps negatives to 00:00', () => {
    expect(formatMs(-5_000)).toBe('00:00');
  });
});
