import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TokenBucket } from '../src/ratelimit.js';

describe('TokenBucket', () => {
  it('allows up to capacity then refills over time', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 }, t0);
    assert.ok(bucket.take(1, t0));
    assert.ok(bucket.take(1, t0));
    assert.ok(bucket.take(1, t0));
    assert.ok(!bucket.take(1, t0));
    assert.ok(bucket.take(1, t0 + 1500));
  });
});
