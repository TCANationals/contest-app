// Server-clock drift sampler (§11.6). Samples the HTTP Date header from
// https://time.cloudflare.com every 5 minutes; drifts > 200 ms append a
// SYSTEM_CLOCK_WARN audit row for a synthetic `_system_` room. The clock
// sampler is best-effort and MUST NOT crash on fetch failures.

import { insertAuditEvent, listActiveRooms } from './db/dal.js';

export const CLOCK_DRIFT_THRESHOLD_MS = 200;
export const CLOCK_DRIFT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
export const CLOCK_DRIFT_SAMPLE_URL = 'https://time.cloudflare.com';

export async function sampleClockDriftOnce(
  url: string = CLOCK_DRIFT_SAMPLE_URL,
): Promise<number | null> {
  try {
    const t0 = Date.now();
    const res = await fetch(url, { method: 'HEAD' });
    const t3 = Date.now();
    const header = res.headers.get('date');
    if (!header) return null;
    const serverMs = Date.parse(header);
    if (!Number.isFinite(serverMs)) return null;
    const rtt = t3 - t0;
    // Compare server time to our estimated midpoint.
    const localMid = t0 + rtt / 2;
    return localMid - serverMs;
  } catch {
    return null;
  }
}

export function startClockDriftMonitor(
  log: (msg: string, extra?: unknown) => void = () => {},
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      const drift = await sampleClockDriftOnce();
      if (drift == null) return;
      if (Math.abs(drift) > CLOCK_DRIFT_THRESHOLD_MS) {
        log('system_clock_warn', { driftMs: drift });
        const rooms = await listActiveRooms().catch(() => []);
        if (rooms.length > 0 && rooms[0]) {
          await insertAuditEvent({
            room: rooms[0].id,
            atServerMs: Date.now(),
            actorSub: 'system',
            actorEmail: null,
            eventType: 'SYSTEM_CLOCK_WARN',
            payload: { driftMs: drift },
          }).catch(() => {});
        }
      }
    })();
  }, CLOCK_DRIFT_SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
