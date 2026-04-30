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

  it('overnight: morning tail uses the previous day weekday bit', () => {
    // Quiet 22:00–06:00, only Thursday (bit 4) enabled.
    const cfg = {
      start: '22:00',
      end: '06:00',
      weekdays: 1 << 4,
      timezone: 'UTC',
    };
    // Thu (Apr 30) 23:00 — evening half, Thursday bit applies → true.
    expect(isInQuietHours(cfg, utc(30, 23))).toBe(true);
    // Fri (May 1) 02:00 — morning tail of the Thursday window → true.
    expect(isInQuietHours(cfg, new Date(Date.UTC(2026, 4, 1, 2, 0, 0)))).toBe(true);
    // Fri (May 1) 23:00 — evening, but Friday bit not set → false.
    expect(isInQuietHours(cfg, new Date(Date.UTC(2026, 4, 1, 23, 0, 0)))).toBe(false);
    // Sat (May 2) 02:00 — morning tail belongs to Friday, also not set → false.
    expect(isInQuietHours(cfg, new Date(Date.UTC(2026, 4, 2, 2, 0, 0)))).toBe(false);
  });

  it("overnight: weekday bit only applies to that day's evening half", () => {
    // Quiet 22:00–06:00, only Sunday enabled.
    const cfg = {
      start: '22:00',
      end: '06:00',
      weekdays: 1 << 0,
      timezone: 'UTC',
    };
    // Sun 23:00 → evening half, Sunday bit set → true.
    // 2026-05-03 is a Sunday.
    expect(isInQuietHours(cfg, new Date(Date.UTC(2026, 4, 3, 23, 0, 0)))).toBe(true);
    // Mon 02:00 → tail of the Sunday window → true.
    expect(isInQuietHours(cfg, new Date(Date.UTC(2026, 4, 4, 2, 0, 0)))).toBe(true);
    // Sun 02:00 → tail belongs to Saturday, not set → false.
    expect(isInQuietHours(cfg, new Date(Date.UTC(2026, 4, 3, 2, 0, 0)))).toBe(false);
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
