import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isInQuietHours } from '../src/notify/quiet-hours.js';

// Sun=bit0 ... Sat=bit6.
const ALL_DAYS = 127;

describe('quiet hours (§7.4.4)', () => {
  it('returns false when start/end is null', () => {
    const res = isInQuietHours(
      { start: null, end: null, weekdays: ALL_DAYS, timezone: 'UTC' },
      new Date('2026-04-30T02:00:00Z'),
    );
    assert.equal(res, false);
  });

  it('returns false when weekdays bitmask is 0', () => {
    const res = isInQuietHours(
      { start: '22:00', end: '06:00', weekdays: 0, timezone: 'UTC' },
      new Date('2026-04-30T02:00:00Z'),
    );
    assert.equal(res, false);
  });

  it('same-day window in UTC', () => {
    // Thursday (bit 4) 2026-04-30 at 03:00 UTC inside a 02:00-04:00 window.
    const spec = { start: '02:00', end: '04:00', weekdays: 1 << 4, timezone: 'UTC' };
    assert.equal(isInQuietHours(spec, new Date('2026-04-30T03:00:00Z')), true);
    assert.equal(isInQuietHours(spec, new Date('2026-04-30T04:00:00Z')), false);
    assert.equal(isInQuietHours(spec, new Date('2026-04-30T01:59:00Z')), false);
  });

  it('overnight window (end < start)', () => {
    // 22:00 Thursday → 06:00 Friday (UTC). Thursday bitmask only.
    const thursdayBit = 1 << 4;
    const fridayBit = 1 << 5;
    const spec = {
      start: '22:00',
      end: '06:00',
      weekdays: thursdayBit | fridayBit,
      timezone: 'UTC',
    };
    // Thursday 23:00 UTC
    assert.equal(isInQuietHours(spec, new Date('2026-04-30T23:00:00Z')), true);
    // Friday 03:00 UTC (still in "Thursday night" window)
    assert.equal(isInQuietHours(spec, new Date('2026-05-01T03:00:00Z')), true);
    // Friday 07:00 UTC (out)
    assert.equal(isInQuietHours(spec, new Date('2026-05-01T07:00:00Z')), false);
    // Thursday 20:00 UTC (before start)
    assert.equal(isInQuietHours(spec, new Date('2026-04-30T20:00:00Z')), false);
  });

  it('timezone shifts the window', () => {
    // 22:00-06:00 America/Chicago. 2026-04-30 04:00 UTC is 23:00 Wed
    // (2026-04-29 in local CDT), so inside the Wed→Thu overnight window.
    const wednesdayBit = 1 << 3;
    const thursdayBit = 1 << 4;
    const spec = {
      start: '22:00',
      end: '06:00',
      weekdays: wednesdayBit | thursdayBit,
      timezone: 'America/Chicago',
    };
    assert.equal(isInQuietHours(spec, new Date('2026-04-30T04:00:00Z')), true);
    // Same UTC instant but only Thursday enabled: Wed night should not count.
    const thursOnly = { ...spec, weekdays: thursdayBit };
    assert.equal(isInQuietHours(thursOnly, new Date('2026-04-30T04:00:00Z')), false);
  });
});
