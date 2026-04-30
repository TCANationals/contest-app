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

  it('flushRetries stops at the first failure, leaving the job at the head', async () => {
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
    assert.equal(flushed, 1); // only the first job ran
    assert.equal(succeeded, 1);
    assert.equal(ringSize(), 2); // failing job is still at the head
    assert.equal(isDbDegraded(), true);
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
