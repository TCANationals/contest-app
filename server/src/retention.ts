// Audit-log retention job (§11.4). Daily prune of rows older than 90 days.

import { pruneAuditLog } from './db/dal.js';

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function runPruneOnce(
  now: number = Date.now(),
  retention: number = AUDIT_RETENTION_MS,
): Promise<number> {
  return pruneAuditLog(now - retention);
}

export function startRetentionJob(
  log: (msg: string, extra?: unknown) => void = () => {},
): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const n = await runPruneOnce();
        if (n > 0) log('audit_pruned', { rows: n });
      } catch (err) {
        log('audit_prune_failed', err);
      }
    })();
  }, PRUNE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
