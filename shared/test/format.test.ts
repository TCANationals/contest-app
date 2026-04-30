import { describe, expect, it } from 'vitest';

import { formatCountdown, formatMs } from '../src/format';

describe('formatMs', () => {
  it('formats MM:SS under an hour', () => {
    expect(formatMs(0)).toBe('00:00');
    expect(formatMs(59_500)).toBe('00:59');
    expect(formatMs(60_000)).toBe('01:00');
    expect(formatMs(65_000)).toBe('01:05');
    expect(formatMs(3 * 60_000 + 9_000)).toBe('03:09');
  });

  it('formats H:MM:SS at or above an hour', () => {
    expect(formatMs(3_600_000)).toBe('1:00:00');
    expect(formatMs(2 * 3_600_000 + 3 * 60_000 + 5_000)).toBe('2:03:05');
    expect(formatMs(10 * 60 * 60_000)).toBe('10:00:00');
  });

  it('rounds milliseconds DOWN to whole seconds', () => {
    // 999 ms still reads 00:00 — matches the §9.5.1 alarm boundary
    // which fires once remaining first crosses zero.
    expect(formatMs(999)).toBe('00:00');
    expect(formatMs(1_000)).toBe('00:01');
    expect(formatMs(1_999)).toBe('00:01');
  });

  it('clamps negatives to 00:00', () => {
    expect(formatMs(-10)).toBe('00:00');
    expect(formatMs(-5_000)).toBe('00:00');
  });
});

describe('formatCountdown', () => {
  it('idle is always --:--', () => {
    expect(formatCountdown('idle', 30_000)).toBe('--:--');
    expect(formatCountdown('idle', null)).toBe('--:--');
  });

  it('null remainingMs reads --:-- regardless of status', () => {
    expect(formatCountdown('running', null)).toBe('--:--');
    expect(formatCountdown('paused', null)).toBe('--:--');
  });

  it('paused shows remaining time', () => {
    expect(formatCountdown('paused', 125_000)).toBe('02:05');
  });

  it('running shows remaining time', () => {
    expect(formatCountdown('running', 9_000)).toBe('00:09');
  });
});
