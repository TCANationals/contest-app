// Server-clock drift sampler (§11.6). Samples the HTTP Date header from
// https://time.cloudflare.com every 5 minutes; drifts > 200 ms append a
// SYSTEM_CLOCK_WARN audit row.
//
// The `audit_log.room` column is a FK to `rooms.id` (§11.3), so we cannot
// use a synthetic `_system_` room without a schema change. Instead, a
// clock-drift warning fans out to every active room so judges reviewing
// their own room's audit log see it. If no rooms exist, the warning is
// logged via the supplied logger callback.

import { insertAuditEvent, listActiveRooms } from './db/dal.js';

export const CLOCK_DRIFT_THRESHOLD_MS = 200;
export const CLOCK_DRIFT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const CLOCK_DRIFT_SAMPLE_URL = 'https://time.cloudflare.com';

/**
 * The HTTP `Date` header is only second-precision (RFC 7231 §7.1.1.1), so the
 * parsed ms value is the *start* of the second the server was in when it
 * generated the response. The server's actual clock at that instant lies
 * anywhere in `[serverMs, serverMs + 1000)`. We correct for that by using
 * the midpoint (`serverMs + 500`) as our point estimate; the remaining
 * quantization uncertainty is ±500 ms.
 */
export const HTTP_DATE_QUANTIZATION_MS = 500;

export async function sampleClockDriftOnce(
  url: string = CLOCK_DRIFT_SAMPLE_URL,
): Promise<number | null> {
  try {
    const t0 = Date.now();
    const res = await fetch(url, { method: 'HEAD' });
    const t3 = Date.now();
    const header = res.headers.get('date');
    if (!header) return null;
    const serverMsStart = Date.parse(header);
    if (!Number.isFinite(serverMsStart)) return null;
    const serverMs = serverMsStart + HTTP_DATE_QUANTIZATION_MS;
    const rtt = t3 - t0;
    const localMid = t0 + rtt / 2;
    return localMid - serverMs;
  } catch {
    return null;
  }
}

/**
 * Returns true only when the measured drift's uncertainty band is entirely
 * outside the ±threshold tolerance. Consumes the ±HTTP_DATE_QUANTIZATION_MS
 * quantization as additional slack, so a perfectly-synced host never trips
 * the warning.
 */
export function isDriftSignificant(
  driftMs: number,
  threshold: number = CLOCK_DRIFT_THRESHOLD_MS,
): boolean {
  return Math.abs(driftMs) > threshold + HTTP_DATE_QUANTIZATION_MS;
}

/**
 * Log a drift warning to the audit log. Writes one row per active room.
 * If there are no active rooms, the warning is surfaced through `log` only.
 * Returns the number of audit rows written.
 */
export async function logClockDriftWarning(
  driftMs: number,
  log: (msg: string, extra?: unknown) => void = () => {},
): Promise<number> {
  const rooms = await listActiveRooms().catch(() => []);
  if (rooms.length === 0) {
    log('system_clock_warn_no_rooms', { driftMs });
    return 0;
  }
  let written = 0;
  await Promise.all(
    rooms.map(async (r) => {
      try {
        await insertAuditEvent({
          room: r.id,
          atServerMs: Date.now(),
          actorSub: 'system',
          actorEmail: null,
          eventType: 'SYSTEM_CLOCK_WARN',
          payload: { driftMs },
        });
        written += 1;
      } catch (err) {
        log('system_clock_warn_write_failed', { roomId: r.id, err });
      }
    }),
  );
  return written;
}

export function startClockDriftMonitor(
  log: (msg: string, extra?: unknown) => void = () => {},
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      const drift = await sampleClockDriftOnce();
      if (drift == null) return;
      if (isDriftSignificant(drift)) {
        log('system_clock_warn', { driftMs: drift });
        await logClockDriftWarning(drift, log);
      }
    })();
  }, CLOCK_DRIFT_SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
