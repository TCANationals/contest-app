import { describe, expect, it } from 'vitest';

import { isInQuietHours } from '../src/lib/quietHours';

// Helper: craft a UTC Date that corresponds to 2026-04-30 (a Thursday).
function utc(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 3, day, hour, minute, 0));
}

describe('isInQuietHours', () => {
  it('returns false when no start/end configured', () => {
    expect(
      isInQuietHours({
        start: null,
        end: null,
        weekdays: 0x7f,
        timezone: 'UTC',
      }, utc(30, 12)),
    ).toBe(false);
  });

  it('returns false when weekday mask is 0', () => {
    expect(
      isInQuietHours({
        start: '22:00',
        end: '06:00',
        weekdays: 0,
        timezone: 'UTC',
      }, utc(30, 23)),
    ).toBe(false);
  });

  it('matches a regular window on the configured weekday', () => {
    // Thursday 14:30 UTC, window 09:00–17:00, weekdays include Thu (bit 4).
    expect(
      isInQuietHours({
        start: '09:00',
        end: '17:00',
        weekdays: 1 << 4,
        timezone: 'UTC',
      }, utc(30, 14, 30)),
    ).toBe(true);
  });

  it('excludes times outside the window', () => {
    expect(
      isInQuietHours({
        start: '09:00',
        end: '17:00',
        weekdays: 0x7f,
        timezone: 'UTC',
      }, utc(30, 8)),
    ).toBe(false);
    expect(
      isInQuietHours({
        start: '09:00',
        end: '17:00',
        weekdays: 0x7f,
        timezone: 'UTC',
      }, utc(30, 17)),
    ).toBe(false);
  });

  it('handles overnight windows (end < start)', () => {
    // 22:00–06:00
    const cfg = {
      start: '22:00',
      end: '06:00',
      weekdays: 0x7f,
      timezone: 'UTC',
    };
    expect(isInQuietHours(cfg, utc(30, 23))).toBe(true);
    expect(isInQuietHours(cfg, utc(30, 2))).toBe(true);
    expect(isInQuietHours(cfg, utc(30, 12))).toBe(false);
  });

  it('respects non-UTC timezone when evaluating weekday/time-of-day', () => {
    // 2026-04-30 03:00 UTC is 2026-04-29 22:00 America/Chicago (Wed),
    // which falls inside a 20:00–23:00 quiet window restricted to Wed (bit 3).
    const cfg = {
      start: '20:00',
      end: '23:00',
      weekdays: 1 << 3,
      timezone: 'America/Chicago',
    };
    expect(isInQuietHours(cfg, utc(30, 3))).toBe(true);
    // The same instant in UTC would be Thursday — so the UTC-only weekday
    // mask (bit 4) should *not* match when we evaluate in UTC mode:
    expect(
      isInQuietHours(
        { ...cfg, timezone: 'UTC', weekdays: 1 << 3 },
        utc(30, 3),
      ),
    ).toBe(false);
  });
});
