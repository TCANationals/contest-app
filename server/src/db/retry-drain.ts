// Periodic drain for the in-process retry ring buffer (§11.5).
//
// `enqueueRetry` parks failed DB writes so the WebSocket broadcast path
// never stalls on a slow/unreachable Postgres (per the mutation-discipline
// rules in §11.5). Without a drain, `ring.length > 0` makes
// `isDbDegraded()` latch `true` forever, so every outbound STATE frame
// would report `dbDegraded: true` even after Postgres recovers. This job
// flushes the ring every 5 seconds; on the first successful pass the ring
// is empty again and `dbDegraded` clears.

import { flushRetries, isDbDegraded, ringSize } from './dal.js';

export const DRAIN_INTERVAL_MS = 5_000;

export function startRetryDrain(
  log: (msg: string, extra?: unknown) => void = () => {},
  intervalMs: number = DRAIN_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    if (!isDbDegraded()) return;
    void (async () => {
      try {
        const flushed = await flushRetries(log);
        if (flushed > 0) {
          log('retry_drain_flushed', { count: flushed, remaining: ringSize() });
        }
      } catch (err) {
        log('retry_drain_failed', err);
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
