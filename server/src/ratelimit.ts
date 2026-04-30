// Per-connection token buckets (§6.4). Stub for scaffolding.

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

// TODO: wire in per-frame-type limits from §6.4.
