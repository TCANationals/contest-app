/**
 * Quiet-hours evaluation (§7.4 / §7.4.4).
 *
 * - `weekdays` is a bitmask: bit 0 = Sunday … bit 6 = Saturday. 0 disables.
 * - `start` and `end` are "HH:MM" or "HH:MM:SS" strings in `timezone`.
 * - If `end < start`, the window wraps midnight (overnight quiet hours).
 *
 * Returns true when the given instant falls inside quiet hours for the judge.
 */

export interface QuietHoursConfig {
  start: string | null;
  end: string | null;
  weekdays: number;
  timezone: string;
}

export function isInQuietHours(cfg: QuietHoursConfig, now: Date = new Date()): boolean {
  const { start, end, weekdays, timezone } = cfg;
  if (!start || !end) return false;
  if (weekdays === 0) return false;

  const tzParts = localParts(now, timezone);
  const nowSec = tzParts.secondOfDay;
  const startSec = parseTime(start);
  const endSec = parseTime(end);
  if (startSec == null || endSec == null) return false;

  if (endSec >= startSec) {
    // Same-day window: the configured weekday is the only relevant bit.
    if (((weekdays >> tzParts.weekday) & 1) === 0) return false;
    return nowSec >= startSec && nowSec < endSec;
  }

  // Overnight window (end < start) — splits across two calendar days.
  // Evening portion (>= start): the window is "owned" by today's weekday bit.
  // Morning portion  (< end):   the window started YESTERDAY, so the relevant
  // weekday bit is yesterday's. Without this distinction, e.g. quiet hours
  // 22:00–06:00 with only Thu enabled would miss Fri 02:00 even though that
  // is the tail end of the Thursday window.
  if (nowSec >= startSec) {
    return ((weekdays >> tzParts.weekday) & 1) !== 0;
  }
  if (nowSec < endSec) {
    const yesterday = (tzParts.weekday + 6) % 7;
    return ((weekdays >> yesterday) & 1) !== 0;
  }
  return false;
}

function parseTime(hhmmss: string): number | null {
  const parts = hhmmss.split(':').map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => Number.isNaN(p))) return null;
  const [h = 0, m = 0, s = 0] = parts;
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

interface TzParts {
  weekday: number; // 0 = Sunday, 6 = Saturday
  secondOfDay: number;
}

function localParts(date: Date, timezone: string): TzParts {
  // Intl.DateTimeFormat with `weekday: 'short'` returns e.g. "Sun"; use a
  // stable mapping to avoid locale drift.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
  const days: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const weekday = days[map.weekday ?? 'Sun'] ?? 0;
  // Some locales render hour="24" at midnight; coerce to 0.
  const hour = Number(map.hour ?? '0') % 24;
  const minute = Number(map.minute ?? '0');
  const second = Number(map.second ?? '0');
  return { weekday, secondOfDay: hour * 3600 + minute * 60 + second };
}
