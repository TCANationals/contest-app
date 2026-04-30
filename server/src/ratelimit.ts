// Per-connection token buckets + abuse tracker (§6.4).

export interface TokenBucketConfig {
  capacity: number;
  refillPerSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly config: TokenBucketConfig,
    now: number = Date.now(),
  ) {
    this.tokens = config.capacity;
    this.lastRefillMs = now;
  }

  take(count = 1, now: number = Date.now()): boolean {
    const elapsedSec = Math.max(0, (now - this.lastRefillMs) / 1000);
    this.tokens = Math.min(
      this.config.capacity,
      this.tokens + elapsedSec * this.config.refillPerSecond,
    );
    this.lastRefillMs = now;
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }
}

/**
 * Per-frame-type limits from §6.4. The capacities below are the hard caps
 * (frames/min); the refill rate is chosen so a full bucket refills over
 * one minute.
 */
export type LimitKey = 'PING' | 'HELP_REQUEST' | 'HELP_CANCEL' | 'TIMER' | 'HELP_ACK';

export const LIMIT_CONFIG: Record<LimitKey, TokenBucketConfig & { abuseThreshold: number }> = {
  PING:         { capacity: 10, refillPerSecond: 10 / 60,  abuseThreshold: 100 },
  HELP_REQUEST: { capacity: 6,  refillPerSecond: 6 / 60,   abuseThreshold: 20  },
  HELP_CANCEL:  { capacity: 6,  refillPerSecond: 6 / 60,   abuseThreshold: 20  },
  TIMER:        { capacity: 60, refillPerSecond: 60 / 60,  abuseThreshold: 120 },
  HELP_ACK:     { capacity: 60, refillPerSecond: 60 / 60,  abuseThreshold: 120 },
};

const ABUSE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Tracks per-connection per-frame-type rate limits and abuse thresholds.
 * Each call to `consume` returns whether the frame should be processed,
 * whether the drop counts as abuse (connection should be closed with 1008),
 * and the frame-type name for logging.
 */
export class RateLimiter {
  private readonly buckets = new Map<LimitKey, TokenBucket>();
  private readonly drops = new Map<LimitKey, number[]>();

  constructor(now: number = Date.now()) {
    for (const key of Object.keys(LIMIT_CONFIG) as LimitKey[]) {
      this.buckets.set(key, new TokenBucket(LIMIT_CONFIG[key], now));
      this.drops.set(key, []);
    }
  }

  consume(
    key: LimitKey,
    now: number = Date.now(),
  ): { allowed: boolean; abusive: boolean; droppedCount: number } {
    const bucket = this.buckets.get(key)!;
    if (bucket.take(1, now)) {
      return { allowed: true, abusive: false, droppedCount: 0 };
    }
    const drops = this.drops.get(key)!;
    drops.push(now);
    const cutoff = now - ABUSE_WINDOW_MS;
    while (drops.length > 0 && drops[0]! < cutoff) {
      drops.shift();
    }
    const abusive = drops.length >= LIMIT_CONFIG[key].abuseThreshold;
    return { allowed: false, abusive, droppedCount: drops.length };
  }
}

/**
 * Per-source-IP new-connection limiter (§6.4): 30/min, token bucket.
 *
 * Uses a bounded LRU with idle-based eviction so the table doesn't grow
 * unboundedly across the lifetime of a long-running server. A bucket that
 * has been full (i.e., fully refilled and therefore indistinguishable from
 * a fresh one) for longer than `idleTtlMs` is dropped on the next insertion
 * or the next periodic sweep.
 */
export const IP_LIMITER_MAX_ENTRIES = 10_000;
export const IP_LIMITER_IDLE_TTL_MS = 10 * 60 * 1000;

interface IpEntry {
  bucket: TokenBucket;
  lastSeenMs: number;
}

export class IpConnectionLimiter {
  private readonly buckets = new Map<string, IpEntry>();
  private readonly config: TokenBucketConfig;
  private readonly maxEntries: number;
  private readonly idleTtlMs: number;

  constructor(
    capacity = 30,
    refillPerSecond = 30 / 60,
    maxEntries: number = IP_LIMITER_MAX_ENTRIES,
    idleTtlMs: number = IP_LIMITER_IDLE_TTL_MS,
  ) {
    this.config = { capacity, refillPerSecond };
    this.maxEntries = maxEntries;
    this.idleTtlMs = idleTtlMs;
  }

  allow(ip: string, now: number = Date.now()): boolean {
    let entry = this.buckets.get(ip);
    if (entry) {
      // LRU touch: re-insert so it lands at the tail.
      this.buckets.delete(ip);
    } else {
      entry = { bucket: new TokenBucket(this.config, now), lastSeenMs: now };
    }
    entry.lastSeenMs = now;
    this.buckets.set(ip, entry);

    if (this.buckets.size > this.maxEntries) {
      this.evictIdle(now);
      // If the table is still over the cap, drop the oldest entries until
      // we're back under the cap. `Map` iterates in insertion order, so
      // `keys().next()` is the LRU head.
      while (this.buckets.size > this.maxEntries) {
        const oldest = this.buckets.keys().next().value;
        if (oldest == null) break;
        this.buckets.delete(oldest);
      }
    }

    return entry.bucket.take(1, now);
  }

  /**
   * Drop every IP whose bucket has been idle longer than `idleTtlMs`.
   * Returns the number of evicted entries. Safe to call at any time.
   */
  evictIdle(now: number = Date.now()): number {
    const cutoff = now - this.idleTtlMs;
    let evicted = 0;
    for (const [ip, entry] of this.buckets) {
      if (entry.lastSeenMs < cutoff) {
        this.buckets.delete(ip);
        evicted += 1;
      } else {
        // Insertion-ordered iteration: once we hit a fresh entry, every
        // subsequent entry is at least as fresh.
        break;
      }
    }
    return evicted;
  }

  size(): number {
    return this.buckets.size;
  }
}

export const ROOM_CONNECTION_CAP = 200;
export const APPLICATION_HEARTBEAT_TIMEOUT_MS = 90 * 1000;
