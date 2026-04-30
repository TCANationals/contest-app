export interface TokenBucketConfig {
  refillPerMinute: number;
  burst: number;
}

export class TokenBucket {
  public constructor(_config: TokenBucketConfig) {
    // TODO(spec §6.4): implement per-connection token bucket.
  }

  public consume(_count = 1): boolean {
    // TODO(spec §6.4): return false when frame should be dropped.
    return true;
  }
}
