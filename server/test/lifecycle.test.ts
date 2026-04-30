// Verifies that `app.close()` tears down every background job started by
// `buildServer`. Before the fix, `startClockDriftMonitor`,
// `startRetentionJob`, and `startRetryDrain` had their stop handles
// discarded, so the intervals kept firing — and with them, their
// callbacks that may reference a closed Postgres pool.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildServer } from '../src/index.js';

interface TimerAccess {
  _getActiveHandles?: () => unknown[];
}

describe('server lifecycle', () => {
  it('buildServer + app.close() does not leak background-job timers', async () => {
    const before = countTimerHandles();
    const app = await buildServer();
    const duringMid = countTimerHandles();
    await app.close();
    const after = countTimerHandles();

    // Starting three background intervals adds timer handles while the
    // server is up; closing the app MUST bring the count back down to
    // the starting baseline. Without the fix, the three background
    // intervals would remain registered after close and this delta
    // would be ≥ 3.
    assert.ok(
      duringMid >= before,
      `sanity: timer count should grow after buildServer; before=${before} during=${duringMid}`,
    );
    assert.ok(
      after - before <= 0,
      `expected all background timers to stop on close; before=${before} during=${duringMid} after=${after}`,
    );
  });
});

function countTimerHandles(): number {
  const proc = process as unknown as TimerAccess;
  const handles = proc._getActiveHandles?.() ?? [];
  return handles.filter((h) => {
    const name = (h as { constructor?: { name?: string } })?.constructor?.name;
    return name === 'Timeout' || name === 'Immediate';
  }).length;
}
