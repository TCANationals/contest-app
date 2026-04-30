// Periodic drain for the in-process retry ring buffer (§11.5).
//
// `enqueueRetry` parks failed DB writes so the WebSocket broadcast path
// never stalls on a slow/unreachable Postgres (per the mutation-discipline
// rules in §11.5). Without a drain, `ring.length > 0` makes
// `isDbDegraded()` latch `true` forever, so every outbound STATE frame
// would report `dbDegraded: true` even after Postgres recovers. This job
// flushes the ring every 5 seconds; on the first successful pass the ring
// is empty again and `dbDegraded` clears.
//
// The drain is single-flight: a slow pass (e.g., one that stalls on a
// long Postgres reconnection timeout) won't overlap with the next
// interval tick. Without this guard, two concurrent passes could shift
// the same requeued entry off the ring in quick succession and
// double-count `entry.attempts`, dead-lettering transient failures
// prematurely.

import { flushRetries, isDbDegraded, ringSize } from './dal.js';

export const DRAIN_INTERVAL_MS = 5_000;

export function startRetryDrain(
  log: (msg: string, extra?: unknown) => void = () => {},
  intervalMs: number = DRAIN_INTERVAL_MS,
): () => void {
  let inflight = false;
  const timer = setInterval(() => {
    if (inflight) return;
    if (!isDbDegraded()) return;
    inflight = true;
    void (async () => {
      try {
        const flushed = await flushRetries(log);
        if (flushed > 0) {
          log('retry_drain_flushed', { count: flushed, remaining: ringSize() });
        }
      } catch (err) {
        log('retry_drain_failed', err);
      } finally {
        inflight = false;
      }
    })();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
