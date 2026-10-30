import type {
  DatabaseAdapter,
  ParameterizedQuery,
  QueryExecutionResult
} from '../../contracts/database-adapter.js';
import type {
  IQueryExecutionSupervisor,
  IRateLimiter,
  OperationalLimitsPolicy
} from '../../contracts/cost-limits.contract.js';
import {
  QueryExecutionTimeoutError,
  RateLimitExceededError
} from '../errors.js';

export class QueryExecutionSupervisor implements IQueryExecutionSupervisor {
  private readonly adapter: DatabaseAdapter;
  private readonly rateLimiter?: IRateLimiter;

  constructor(adapter: DatabaseAdapter, rateLimiter?: IRateLimiter) {
    this.adapter = adapter;
    this.rateLimiter = rateLimiter;
  }

  public async executeWithLimits(
    query: ParameterizedQuery,
    requesterId: string,
    limits: OperationalLimitsPolicy
  ): Promise<QueryExecutionResult & { truncated: boolean }> {
    // 1. Rate limiting check (O(1) in memory)
    if (this.rateLimiter) {
      const rateCheck = this.rateLimiter.checkLimit(requesterId);
      if (!rateCheck.allowed) {
        throw new RateLimitExceededError(
          rateCheck.level ?? 'CLIENT',
          rateCheck.limit ?? 60,
          rateCheck.retryAfterSeconds ?? 1
        );
      }
      this.rateLimiter.recordQuery(requesterId);
    }

    // 2. Setup cancellation timeout
    const abortController = new AbortController();
    let timedOut = false;

    if (query.signal) {
      if (query.signal.aborted) {
        abortController.abort();
      } else {
        query.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, limits.executionTimeoutMs);

    if (typeof timeoutTimer.unref === 'function') {
      timeoutTimer.unref();
    }

    try {
      const rawResult = await this.adapter.executeQuery({
        ...query,
        signal: abortController.signal,
        maxRows: limits.maxRowsLimit
      });

      clearTimeout(timeoutTimer);

      if (timedOut) {
        throw new QueryExecutionTimeoutError(this.adapter.adapterId, limits.executionTimeoutMs);
      }

      // 3. Safe row truncation
      const totalReturned = rawResult.rows.length;
      if (totalReturned > limits.maxRowsLimit) {
        return {
          ...rawResult,
          rows: rawResult.rows.slice(0, limits.maxRowsLimit),
          rowCount: limits.maxRowsLimit,
          truncated: true
        };
      }

      return {
        ...rawResult,
        truncated: false
      };
    } catch (err: unknown) {
      clearTimeout(timeoutTimer);
      if (timedOut || abortController.signal.aborted) {
        throw new QueryExecutionTimeoutError(this.adapter.adapterId, limits.executionTimeoutMs);
      }
      throw err;
    }
  }
}
