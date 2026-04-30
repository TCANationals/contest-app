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
 */
export class IpConnectionLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly config: TokenBucketConfig;

  constructor(capacity = 30, refillPerSecond = 30 / 60) {
    this.config = { capacity, refillPerSecond };
  }

  allow(ip: string, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(this.config, now);
      this.buckets.set(ip, bucket);
    }
    return bucket.take(1, now);
  }
}

export const ROOM_CONNECTION_CAP = 200;
export const APPLICATION_HEARTBEAT_TIMEOUT_MS = 90 * 1000;
