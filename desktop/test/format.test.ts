import { describe, it, expect } from 'vitest';
import { formatCountdown } from '../src/format';

describe('formatCountdown', () => {
  it('returns placeholder for null', () => {
    expect(formatCountdown(null)).toBe('--:--');
  });

  it('formats MM:SS under an hour', () => {
    expect(formatCountdown(65_000)).toBe('01:05');
  });

  it('formats H:MM:SS at or above an hour', () => {
    expect(formatCountdown(3_600_000 + 65_000)).toBe('1:01:05');
  });

  it('clamps negative to zero', () => {
    expect(formatCountdown(-10)).toBe('00:00');
  });
});
