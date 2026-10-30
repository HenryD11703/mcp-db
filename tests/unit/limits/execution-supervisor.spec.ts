import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter, ParameterizedQuery, QueryExecutionResult } from '../../../src/contracts/database-adapter.js';
import type { OperationalLimitsPolicy } from '../../../src/contracts/cost-limits.contract.js';
import { QueryExecutionSupervisor } from '../../../src/core/limits/execution-supervisor.js';
import { QueryExecutionTimeoutError, RateLimitExceededError } from '../../../src/core/errors.js';
import { TwoTierRateLimiter } from '../../../src/core/limits/rate-limiter.js';

function createMockAdapter(
  resultGenerator: (query: ParameterizedQuery) => Promise<QueryExecutionResult>
): DatabaseAdapter {
  return {
    dialect: 'postgres',
    adapterId: 'supervisor-test',
    verifyReadOnly: async () => ({
      isReadOnly: true,
      principalName: 'test',
      sessionReadOnlyEnforced: true,
      violations: [],
      checkedAt: new Date().toISOString()
    }),
    analyzeQueryPlan: async () => ({
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 10,
      estimatedCost: 1.0,
      scannedTables: [],
      rawPlanSummary: 'Index Scan'
    }),
    executeQuery: resultGenerator,
    introspectSchema: async () => ({
      databaseName: 'test',
      dialect: 'postgres',
      tables: [],
      foreignKeys: [],
      inspectedAt: new Date().toISOString()
    }),
    close: async () => {}
  };
}

describe('QueryExecutionSupervisor (User Story 2 - P1)', () => {
  const policy: OperationalLimitsPolicy = {
    executionTimeoutMs: 100,
    maxRowsLimit: 5,
    rateLimitPerClientPerMinute: 10,
    rateLimitGlobalPerMinute: 50
  };

  it('safely truncates results when query returns more rows than maxRowsLimit', async () => {
    const adapter = createMockAdapter(async () => ({
      columns: [{ name: 'id', dataType: 'int' }],
      rows: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })),
      rowCount: 20,
      durationMs: 10
    }));

    const supervisor = new QueryExecutionSupervisor(adapter);
    const result = await supervisor.executeWithLimits(
      { sql: 'SELECT * FROM big_table', params: [] },
      'test-client',
      policy
    );

    expect(result.rows).toHaveLength(5);
    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('keeps truncated: false when rows are within maxRowsLimit', async () => {
    const adapter = createMockAdapter(async () => ({
      columns: [{ name: 'id', dataType: 'int' }],
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
      durationMs: 5
    }));

    const supervisor = new QueryExecutionSupervisor(adapter);
    const result = await supervisor.executeWithLimits(
      { sql: 'SELECT * FROM small_table', params: [] },
      'test-client',
      policy
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('dispatches abort signal and throws QueryExecutionTimeoutError on timeout', async () => {
    let receivedSignal: AbortSignal | undefined;

    const adapter = createMockAdapter(async (query) => {
      receivedSignal = query.signal;
      // Simulate slow query listening to abort signal
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            columns: [],
            rows: [],
            rowCount: 0,
            durationMs: 500
          });
        }, 500);

        query.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Query cancelled by driver signal'));
        });
      });
    });

    const supervisor = new QueryExecutionSupervisor(adapter);

    await expect(
      supervisor.executeWithLimits(
        { sql: 'SELECT pg_sleep(1)', params: [] },
        'test-client',
        { ...policy, executionTimeoutMs: 50 }
      )
    ).rejects.toThrow(QueryExecutionTimeoutError);

    expect(receivedSignal?.aborted).toBe(true);
  });

  it('enforces rate limiter and throws RateLimitExceededError before querying adapter', async () => {
    const rateLimiter = new TwoTierRateLimiter({
      clientLimitPerMinute: 2,
      globalLimitPerMinute: 10
    });

    const adapter = createMockAdapter(async () => ({
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 1
    }));

    const supervisor = new QueryExecutionSupervisor(adapter, rateLimiter);

    // 2 allowed
    await supervisor.executeWithLimits({ sql: 'SELECT 1', params: [] }, 'client-x', policy);
    await supervisor.executeWithLimits({ sql: 'SELECT 1', params: [] }, 'client-x', policy);

    // 3rd throttled
    await expect(
      supervisor.executeWithLimits({ sql: 'SELECT 1', params: [] }, 'client-x', policy)
    ).rejects.toThrow(RateLimitExceededError);
  });
});
