// Quiet-hours evaluation (§7.4.4).
//
// A judge's quiet window is defined by:
//   - quiet_hours_start / quiet_hours_end (TIME values; end may be < start
//     to indicate an overnight window)
//   - quiet_hours_weekdays (bitmask: bit 0 = Sun, bit 6 = Sat)
//   - timezone (IANA name)
//
// If start or end is null, quiet hours never apply.

export interface QuietHoursSpec {
  start: string | null;   // 'HH:MM' or 'HH:MM:SS'
  end: string | null;
  weekdays: number;       // bitmask
  timezone: string;
}

function parseTimeToMinutes(t: string | null): number | null {
  if (!t) return null;
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return null;
  return h * 60 + min;
}

/**
 * Return the zoned [weekday, minuteOfDay] for `now` in the given IANA tz.
 * weekday: 0=Sun ... 6=Sat, matching the bitmask convention.
 */
export function zonedWeekdayAndMinute(
  now: Date,
  timezone: string,
): { weekday: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return { weekday: weekday < 0 ? 0 : weekday, minutes: (hour % 24) * 60 + minute };
}

export function isInQuietHours(
  spec: QuietHoursSpec,
  now: Date = new Date(),
): boolean {
  const start = parseTimeToMinutes(spec.start);
  const end = parseTimeToMinutes(spec.end);
  if (start == null || end == null) return false;
  if (spec.weekdays === 0) return false;

  let zoned: { weekday: number; minutes: number };
  try {
    zoned = zonedWeekdayAndMinute(now, spec.timezone || 'UTC');
  } catch {
    zoned = zonedWeekdayAndMinute(now, 'UTC');
  }

  const weekdayActive = (spec.weekdays & (1 << zoned.weekday)) !== 0;

  if (start <= end) {
    // Same-day window: quiet iff today's weekday is active AND within [start, end).
    return weekdayActive && zoned.minutes >= start && zoned.minutes < end;
  }
  // Overnight window: treat the "night" as belonging to the start day.
  // Quiet if:
  //   (today is active AND minutes >= start)  OR
  //   (yesterday is active AND minutes < end)
  if (weekdayActive && zoned.minutes >= start) return true;
  const yesterday = (zoned.weekday + 6) % 7;
  const yesterdayActive = (spec.weekdays & (1 << yesterday)) !== 0;
  if (yesterdayActive && zoned.minutes < end) return true;
  return false;
}
