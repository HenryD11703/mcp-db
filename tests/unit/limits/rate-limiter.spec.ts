import { describe, expect, it, beforeEach } from 'vitest';
import { TwoTierRateLimiter } from '../../../src/core/limits/rate-limiter.js';

describe('TwoTierRateLimiter (User Story 2 - P1)', () => {
  let rateLimiter: TwoTierRateLimiter;

  beforeEach(() => {
    // 3 queries per client per min, 5 global per min for easy unit testing
    rateLimiter = new TwoTierRateLimiter({
      clientLimitPerMinute: 3,
      globalLimitPerMinute: 5
    });
  });

  it('allows queries within client and global limits', () => {
    const res1 = rateLimiter.checkLimit('client-1');
    expect(res1.allowed).toBe(true);
    rateLimiter.recordQuery('client-1');

    const res2 = rateLimiter.checkLimit('client-1');
    expect(res2.allowed).toBe(true);
    rateLimiter.recordQuery('client-1');

    const res3 = rateLimiter.checkLimit('client-1');
    expect(res3.allowed).toBe(true);
    rateLimiter.recordQuery('client-1');
  });

  it('blocks a client when clientLimitPerMinute is exceeded and reports level CLIENT', () => {
    // Use up client-1 quota (3 queries)
    for (let i = 0; i < 3; i++) {
      rateLimiter.recordQuery('client-1');
    }

    const check = rateLimiter.checkLimit('client-1');
    expect(check.allowed).toBe(false);
    expect(check.level).toBe('CLIENT');
    expect(check.limit).toBe(3);
    expect(check.retryAfterSeconds).toBeGreaterThan(0);
    expect(check.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('allows another client when one client is throttled, as long as global limit is not reached', () => {
    // Exhaust client-1
    for (let i = 0; i < 3; i++) {
      rateLimiter.recordQuery('client-1');
    }
    expect(rateLimiter.checkLimit('client-1').allowed).toBe(false);

    // client-2 should still be allowed
    const checkClient2 = rateLimiter.checkLimit('client-2');
    expect(checkClient2.allowed).toBe(true);
  });

  it('blocks all clients when globalLimitPerMinute is exceeded and reports level GLOBAL', () => {
    // client-1 does 3 queries (client-1 exhausted)
    rateLimiter.recordQuery('client-1');
    rateLimiter.recordQuery('client-1');
    rateLimiter.recordQuery('client-1');

    // client-2 does 2 queries (global reaches 5)
    rateLimiter.recordQuery('client-2');
    rateLimiter.recordQuery('client-2');

    // Now global is 5/5. Both client-2 and a new client-3 must be blocked globally
    const checkClient3 = rateLimiter.checkLimit('client-3');
    expect(checkClient3.allowed).toBe(false);
    expect(checkClient3.level).toBe('GLOBAL');
    expect(checkClient3.limit).toBe(5);
    expect(checkClient3.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('clears state on reset()', () => {
    for (let i = 0; i < 3; i++) {
      rateLimiter.recordQuery('client-1');
    }
    expect(rateLimiter.checkLimit('client-1').allowed).toBe(false);

    rateLimiter.reset();

    expect(rateLimiter.checkLimit('client-1').allowed).toBe(true);
  });
});
