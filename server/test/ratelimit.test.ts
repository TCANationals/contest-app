import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  TokenBucket,
  RateLimiter,
  IpConnectionLimiter,
  LIMIT_CONFIG,
} from '../src/ratelimit.js';

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

describe('RateLimiter (§6.4)', () => {
  it('allows PING up to hard cap of 10/min', () => {
    const now = 100_000;
    const limiter = new RateLimiter(now);
    for (let i = 0; i < LIMIT_CONFIG.PING.capacity; i++) {
      assert.equal(limiter.consume('PING', now).allowed, true, `iteration ${i}`);
    }
    assert.equal(limiter.consume('PING', now).allowed, false);
  });

  it('closes connection when abuse threshold reached', () => {
    const now = 100_000;
    const limiter = new RateLimiter(now);
    for (let i = 0; i < LIMIT_CONFIG.HELP_REQUEST.capacity; i++) {
      limiter.consume('HELP_REQUEST', now);
    }
    // Now every extra call is dropped. Push through abuse threshold.
    let lastAbusive = false;
    for (let i = 0; i < LIMIT_CONFIG.HELP_REQUEST.abuseThreshold + 1; i++) {
      const r = limiter.consume('HELP_REQUEST', now + i);
      lastAbusive = r.abusive;
    }
    assert.equal(lastAbusive, true);
  });
});

describe('IpConnectionLimiter', () => {
  it('limits to 30 new connections per minute per IP', () => {
    const t0 = 100_000;
    const limiter = new IpConnectionLimiter();
    for (let i = 0; i < 30; i++) {
      assert.equal(limiter.allow('1.2.3.4', t0), true);
    }
    assert.equal(limiter.allow('1.2.3.4', t0), false);
    // Different IP has its own bucket.
    assert.equal(limiter.allow('5.6.7.8', t0), true);
  });
});
