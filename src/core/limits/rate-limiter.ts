import type {
  IRateLimiter,
  RateLimitCheckResult
} from '../../contracts/cost-limits.contract.js';

export interface RateLimiterOptions {
  readonly clientLimitPerMinute?: number;
  readonly globalLimitPerMinute?: number;
}

export class TwoTierRateLimiter implements IRateLimiter {
  private readonly clientLimitPerMinute: number;
  private readonly globalLimitPerMinute: number;
  private readonly clientBuckets = new Map<string, number[]>();
  private globalBucket: number[] = [];
  private static readonly WINDOW_MS = 60_000;

  constructor(options: RateLimiterOptions = {}) {
    this.clientLimitPerMinute = options.clientLimitPerMinute ?? 60;
    this.globalLimitPerMinute = options.globalLimitPerMinute ?? 300;
  }

  public checkLimit(requesterId: string): RateLimitCheckResult {
    const now = Date.now();
    const windowStart = now - TwoTierRateLimiter.WINDOW_MS;

    // 1. Check client-level quota
    const clientTimestamps = this.prune(this.clientBuckets.get(requesterId) ?? [], windowStart);
    this.clientBuckets.set(requesterId, clientTimestamps);

    if (clientTimestamps.length >= this.clientLimitPerMinute) {
      const oldest = clientTimestamps[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + TwoTierRateLimiter.WINDOW_MS - now) / 1000));
      return {
        allowed: false,
        level: 'CLIENT',
        limit: this.clientLimitPerMinute,
        currentCount: clientTimestamps.length,
        retryAfterSeconds
      };
    }

    // 2. Check global-level quota
    this.globalBucket = this.prune(this.globalBucket, windowStart);

    if (this.globalBucket.length >= this.globalLimitPerMinute) {
      const oldest = this.globalBucket[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + TwoTierRateLimiter.WINDOW_MS - now) / 1000));
      return {
        allowed: false,
        level: 'GLOBAL',
        limit: this.globalLimitPerMinute,
        currentCount: this.globalBucket.length,
        retryAfterSeconds
      };
    }

    return { allowed: true };
  }

  public recordQuery(requesterId: string): void {
    const now = Date.now();
    const windowStart = now - TwoTierRateLimiter.WINDOW_MS;

    const clientTimestamps = this.prune(this.clientBuckets.get(requesterId) ?? [], windowStart);
    clientTimestamps.push(now);
    this.clientBuckets.set(requesterId, clientTimestamps);

    this.globalBucket = this.prune(this.globalBucket, windowStart);
    this.globalBucket.push(now);
  }

  public reset(): void {
    this.clientBuckets.clear();
    this.globalBucket = [];
  }

  private prune(timestamps: number[], windowStart: number): number[] {
    return timestamps.filter((t) => t > windowStart);
  }
}
