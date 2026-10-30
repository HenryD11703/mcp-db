import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  SchemaCatalog
} from '../../src/contracts/database-adapter.js';
import type { EngineRiskThresholds, OperationalLimitsPolicy } from '../../src/contracts/cost-limits.contract.js';
import { QueryPlanRiskEvaluator } from '../../src/core/limits/risk-evaluator.js';
import { TwoTierRateLimiter } from '../../src/core/limits/rate-limiter.js';
import { QueryExecutionSupervisor } from '../../src/core/limits/execution-supervisor.js';
import { QueryExecutionTimeoutError, RateLimitExceededError } from '../../src/core/errors.js';

const thresholds: EngineRiskThresholds = {
  largeTablesBlocklist: ['transacciones_grandes', 'movimientos_historicos', 'auditoria_raw'],
  maxEstimatedRowsCaution: 10000,
  maxEstimatedRowsBlock: 100000,
  maxEstimatedCostCaution: 5000,
  maxEstimatedCostBlock: 50000,
  prohibitCartesianJoins: true,
  planTimeoutMs: 2000
};

const policy: OperationalLimitsPolicy = {
  executionTimeoutMs: 100,
  maxRowsLimit: 100,
  rateLimitPerClientPerMinute: 10,
  rateLimitGlobalPerMinute: 25
};

function createAdversarialAdapter(planRisk: NormalizedRiskProfile): DatabaseAdapter {
  return {
    dialect: 'postgres',
    adapterId: 'adversarial-postgres',
    verifyReadOnly: async (): Promise<ReadOnlyVerificationResult> => ({
      isReadOnly: true,
      principalName: 'mcp_ro',
      sessionReadOnlyEnforced: true,
      violations: [],
      checkedAt: new Date().toISOString()
    }),
    analyzeQueryPlan: async (): Promise<NormalizedRiskProfile> => planRisk,
    executeQuery: async (query: ParameterizedQuery): Promise<QueryExecutionResult> => {
      const signal = query.signal;
      if (signal) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              columns: [{ name: 'id', dataType: 'int' }],
              rows: [{ id: 1 }],
              rowCount: 1,
              durationMs: 300
            });
          }, 300);

          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Query execution cancelled by engine abort signal'));
          });
        });
      }

      return {
        columns: [{ name: 'id', dataType: 'int' }],
        rows: [{ id: 1 }],
        rowCount: 1,
        durationMs: 1
      };
    },
    introspectSchema: async (): Promise<SchemaCatalog> => ({
      databaseName: 'test_db',
      dialect: 'postgres',
      tables: [],
      foreignKeys: [],
      inspectedAt: new Date().toISOString()
    }),
    close: async () => {}
  };
}

describe('Adversarial DoS Attack Suite (Principle VI & SC-001, SC-002, SC-005)', () => {
  it('blocks adversarial multi-table Cartesian product queries without conditions', async () => {
    const adapter = createAdversarialAdapter({
      hasFullScan: false,
      hasUnconditionalJoin: true,
      estimatedRows: 5000000,
      estimatedCost: 150000,
      scannedTables: [],
      rawPlanSummary: 'Nested Loop without join predicate (Cartesian)'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(
      { sql: 'SELECT * FROM tabla_a, tabla_b, tabla_c', params: [] },
      'postgres',
      thresholds
    );

    expect(risk.severity).toBe('CRITICAL_BLOCK');
    expect(risk.hasCartesianJoin).toBe(true);
  });

  it('blocks adversarial full table scans targeted at huge tables', async () => {
    const adapter = createAdversarialAdapter({
      hasFullScan: true,
      hasUnconditionalJoin: false,
      estimatedRows: 2500000,
      estimatedCost: 80000,
      scannedTables: ['transacciones_grandes'],
      rawPlanSummary: 'Seq Scan on transacciones_grandes'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(
      { sql: "SELECT * FROM transacciones_grandes WHERE notas LIKE '%secret%'", params: [] },
      'postgres',
      thresholds
    );

    expect(risk.severity).toBe('CRITICAL_BLOCK');
    expect(risk.hasFullScan).toBe(true);
    expect(risk.scannedTables).toContain('transacciones_grandes');
  });

  it('rejects rapid client flood attacks in <1ms without touching database', () => {
    const rateLimiter = new TwoTierRateLimiter({
      clientLimitPerMinute: 5,
      globalLimitPerMinute: 50
    });

    // 5 allowed
    for (let i = 0; i < 5; i++) {
      expect(rateLimiter.checkLimit('attacker-session').allowed).toBe(true);
      rateLimiter.recordQuery('attacker-session');
    }

    // 6th rejected in O(1)
    const t0 = performance.now();
    const rejection = rateLimiter.checkLimit('attacker-session');
    const elapsed = performance.now() - t0;

    expect(rejection.allowed).toBe(false);
    expect(rejection.level).toBe('CLIENT');
    expect(elapsed).toBeLessThan(1.0); // < 1ms
  });

  it('cancels slow runaway queries concurrently on timeout', async () => {
    const adapter = createAdversarialAdapter({
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 1,
      estimatedCost: 1
    });

    const supervisor = new QueryExecutionSupervisor(adapter);

    const concurrentRuns = Array.from({ length: 3 }, () =>
      supervisor.executeWithLimits(
        { sql: 'SELECT pg_sleep(5)', params: [] },
        'attacker-session',
        policy
      )
    );

    const results = await Promise.allSettled(concurrentRuns);

    for (const res of results) {
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected') {
        expect(res.reason).toBeInstanceOf(QueryExecutionTimeoutError);
      }
    }
  });
});
