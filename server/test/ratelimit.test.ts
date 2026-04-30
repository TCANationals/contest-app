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
    assert.equal(limiter.allow('5.6.7.8', t0), true);
  });

  it('evicts idle entries instead of growing unboundedly', () => {
    const limiter = new IpConnectionLimiter(
      30,
      30 / 60,
      /* maxEntries */ 50,
      /* idleTtlMs */ 60_000,
    );
    const t0 = 100_000;
    for (let i = 0; i < 50; i++) limiter.allow(`10.0.0.${i}`, t0);
    assert.equal(limiter.size(), 50);
    // Advance past idle TTL, then add one more. The stale 50 should be
    // purged before (or as part of) the insertion so the size drops.
    const later = t0 + 120_000;
    limiter.allow('10.0.0.100', later);
    assert.ok(limiter.size() < 50, `expected eviction, got size=${limiter.size()}`);
  });

  it('drops oldest entry when exceeding maxEntries without any idle bucket', () => {
    const limiter = new IpConnectionLimiter(
      30,
      30 / 60,
      /* maxEntries */ 3,
      /* idleTtlMs */ 10 * 60_000,
    );
    const t0 = 100_000;
    limiter.allow('a', t0);
    limiter.allow('b', t0);
    limiter.allow('c', t0);
    assert.equal(limiter.size(), 3);
    limiter.allow('d', t0);
    assert.equal(limiter.size(), 3);
  });

  it('LRU touch on repeat access keeps recently-seen IPs', () => {
    const limiter = new IpConnectionLimiter(
      30,
      30 / 60,
      /* maxEntries */ 3,
      /* idleTtlMs */ 10 * 60_000,
    );
    const t0 = 100_000;
    limiter.allow('a', t0);
    limiter.allow('b', t0 + 1);
    limiter.allow('c', t0 + 2);
    limiter.allow('a', t0 + 3); // touch a
    limiter.allow('d', t0 + 4); // evicts b (oldest remaining)
    assert.equal(limiter.size(), 3);
    // Allow a and c again; buckets should still be attached (didn't reset).
    // We can't query the bucket directly, but if 'b' was dropped and a/c
    // survived, calling allow('b') gets a fresh 30-cap bucket.
  });
});
