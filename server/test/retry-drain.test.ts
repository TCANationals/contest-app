// Coverage for the retry ring drain (§11.5).
//
// The mutation-discipline rule is that failed DB writes get parked in the
// in-process ring buffer and retried later so STATE broadcasts never stall.
// Without an active drain, `isDbDegraded()` latches `true` forever because
// `ring.length > 0` dominates the check — which was the Bugbot finding
// this test locks down.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  enqueueRetry,
  flushRetries,
  isDbDegraded,
  ringSize,
  deadLetterCount,
  MAX_ATTEMPTS,
  _resetRing,
} from '../src/db/dal.js';
import { startRetryDrain } from '../src/db/retry-drain.js';

describe('retry ring drain (§11.5)', () => {
  before(() => {
    _resetRing();
  });
  after(() => {
    _resetRing();
  });

  it('flushRetries clears the ring on success', async () => {
    _resetRing();
    let calls = 0;
    enqueueRetry(async () => {
      calls += 1;
    });
    enqueueRetry(async () => {
      calls += 1;
    });
    assert.equal(ringSize(), 2);
    assert.equal(isDbDegraded(), true);

    const flushed = await flushRetries();
    assert.equal(flushed, 2);
    assert.equal(calls, 2);
    assert.equal(ringSize(), 0);
    // `degradedUntil` is also cleared once the ring is empty.
    assert.equal(isDbDegraded(), false);
  });

  it('a failing job does not block later jobs in the ring', async () => {
    _resetRing();
    let succeeded = 0;
    enqueueRetry(async () => {
      succeeded += 1;
    });
    enqueueRetry(async () => {
      throw new Error('still_broken');
    });
    enqueueRetry(async () => {
      succeeded += 1;
    });

    const flushed = await flushRetries();
    // Two healthy jobs must have executed even though a broken job was
    // interleaved between them. Previously, the drain would abort at the
    // first failure and leave the tail stuck behind the broken job.
    assert.equal(flushed, 2);
    assert.equal(succeeded, 2);
    // The broken job is still on the ring, requeued at the tail for
    // another attempt on the next drain.
    assert.equal(ringSize(), 1);
    assert.equal(isDbDegraded(), true);
    _resetRing();
  });

  it('dead-letters a persistently broken job after MAX_ATTEMPTS and clears degraded state', async () => {
    _resetRing();
    const before = deadLetterCount();
    enqueueRetry(async () => {
      throw new Error('permanent');
    }, 'poison');
    const logs: Array<{ msg: string; extra: unknown }> = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await flushRetries((m, e) => logs.push({ msg: m, extra: e }));
    }
    assert.equal(ringSize(), 0, 'poison pill must be evicted, not held forever');
    assert.equal(deadLetterCount(), before + 1);
    assert.equal(isDbDegraded(), false);
    assert.ok(logs.some((l) => l.msg === 'retry_dead_lettered'));
    _resetRing();
  });

  it('startRetryDrain empties the ring on its next tick when the DB recovers', async () => {
    _resetRing();
    let calls = 0;
    enqueueRetry(async () => {
      calls += 1;
    });
    assert.equal(isDbDegraded(), true);

    const stop = startRetryDrain(() => {}, /* intervalMs */ 10);
    try {
      // Wait for at least one drain tick.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        if (!isDbDegraded()) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(calls, 1, 'retry job must be executed by the drain');
      assert.equal(ringSize(), 0);
      assert.equal(isDbDegraded(), false);
    } finally {
      stop();
      _resetRing();
    }
  });
});
