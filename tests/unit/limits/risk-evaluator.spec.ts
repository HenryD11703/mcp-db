import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter, NormalizedRiskProfile, ParameterizedQuery } from '../../../src/contracts/database-adapter.js';
import type { EngineRiskThresholds } from '../../../src/contracts/cost-limits.contract.js';
import { QueryPlanRiskEvaluator } from '../../../src/core/limits/risk-evaluator.js';

const mockThresholds: EngineRiskThresholds = {
  largeTablesBlocklist: ['transacciones_grandes', 'movimientos_historicos'],
  maxEstimatedRowsCaution: 10000,
  maxEstimatedRowsBlock: 100000,
  maxEstimatedCostCaution: 5000,
  maxEstimatedCostBlock: 50000,
  prohibitCartesianJoins: true,
  planTimeoutMs: 2000
};

function createMockAdapter(
  planResult?: NormalizedRiskProfile,
  delayMs = 0,
  throwError = false
): DatabaseAdapter {
  return {
    dialect: 'postgres',
    adapterId: 'test-postgres',
    verifyReadOnly: async () => ({
      isReadOnly: true,
      principalName: 'test_user',
      sessionReadOnlyEnforced: true,
      violations: [],
      checkedAt: new Date().toISOString()
    }),
    analyzeQueryPlan: async () => {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (throwError) {
        throw new Error('Database metadata catalog lock timeout.');
      }
      return (
        planResult ?? {
          hasFullScan: false,
          hasUnconditionalJoin: false,
          estimatedRows: 50,
          estimatedCost: 10.5,
          scannedTables: [],
          rawPlanSummary: 'Index Scan'
        }
      );
    },
    executeQuery: async () => ({
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 1
    }),
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

describe('QueryPlanRiskEvaluator (User Story 1 - P1)', () => {
  const query: ParameterizedQuery = {
    sql: 'SELECT * FROM transacciones WHERE id = $1',
    params: [{ name: 'id', type: 'number', value: 1 }]
  };

  it('assigns LOW severity to efficient indexed queries within all thresholds', async () => {
    const adapter = createMockAdapter({
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 100,
      estimatedCost: 25.0,
      scannedTables: [],
      rawPlanSummary: 'Index Scan'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', mockThresholds);

    expect(risk.severity).toBe('LOW');
    expect(risk.hasFullScan).toBe(false);
    expect(risk.hasCartesianJoin).toBe(false);
    expect(risk.isVerifiable).toBe(true);
    expect(risk.warnings).toHaveLength(0);
  });

  it('assigns CRITICAL_BLOCK when a full scan touches a table in largeTablesBlocklist', async () => {
    const adapter = createMockAdapter({
      hasFullScan: true,
      hasUnconditionalJoin: false,
      estimatedRows: 500,
      estimatedCost: 100.0,
      scannedTables: ['transacciones_grandes'],
      rawPlanSummary: 'Seq Scan on transacciones_grandes'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', mockThresholds);

    expect(risk.severity).toBe('CRITICAL_BLOCK');
    expect(risk.hasFullScan).toBe(true);
    expect(risk.scannedTables).toContain('transacciones_grandes');
    expect(risk.warnings.some((w) => w.includes('transacciones_grandes'))).toBe(true);
  });

  it('assigns CRITICAL_BLOCK when query has an unconditional Cartesian join and prohibitCartesianJoins is true', async () => {
    const adapter = createMockAdapter({
      hasFullScan: false,
      hasUnconditionalJoin: true,
      estimatedRows: 1000,
      estimatedCost: 500.0,
      scannedTables: [],
      rawPlanSummary: 'Nested Loop without join predicate'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', mockThresholds);

    expect(risk.severity).toBe('CRITICAL_BLOCK');
    expect(risk.hasCartesianJoin).toBe(true);
    expect(risk.warnings.some((w) => w.toLowerCase().includes('cartesiano'))).toBe(true);
  });

  it('assigns CRITICAL_BLOCK when estimated rows exceed maxEstimatedRowsBlock', async () => {
    const adapter = createMockAdapter({
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 150000, // > 100,000
      estimatedCost: 1000.0,
      scannedTables: [],
      rawPlanSummary: 'Index Scan'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', mockThresholds);

    expect(risk.severity).toBe('CRITICAL_BLOCK');
    expect(risk.warnings.some((w) => w.includes('150000'))).toBe(true);
  });

  it('assigns CRITICAL_BLOCK when estimated cost exceeds maxEstimatedCostBlock', async () => {
    const adapter = createMockAdapter({
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 5000,
      estimatedCost: 75000, // > 50,000
      scannedTables: [],
      rawPlanSummary: 'Complex subquery join'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', mockThresholds);

    expect(risk.severity).toBe('CRITICAL_BLOCK');
    expect(risk.warnings.some((w) => w.includes('75000'))).toBe(true);
  });

  it('assigns MEDIUM_CAUTION when estimated rows or cost exceed caution thresholds but not block thresholds', async () => {
    const adapter = createMockAdapter({
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 25000, // Between 10,000 and 100,000
      estimatedCost: 8000, // Between 5,000 and 50,000
      scannedTables: [],
      rawPlanSummary: 'Index Scan with large filter range'
    });

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', mockThresholds);

    expect(risk.severity).toBe('MEDIUM_CAUTION');
    expect(risk.isVerifiable).toBe(true);
    expect(risk.warnings.length).toBeGreaterThan(0);
  });

  it('assigns MEDIUM_CAUTION with isVerifiable: false when adapter throws an error (fail-safe policy)', async () => {
    const adapter = createMockAdapter(undefined, 0, true);

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', mockThresholds);

    expect(risk.severity).toBe('MEDIUM_CAUTION');
    expect(risk.isVerifiable).toBe(false);
    expect(risk.warnings.some((w) => w.includes('Plan no verificable'))).toBe(true);
  });

  it('assigns MEDIUM_CAUTION with isVerifiable: false when plan estimation exceeds planTimeoutMs (fail-safe policy)', async () => {
    // delay 200ms with planTimeoutMs set to 50ms
    const adapter = createMockAdapter(undefined, 200, false);
    const fastThresholds: EngineRiskThresholds = {
      ...mockThresholds,
      planTimeoutMs: 50
    };

    const evaluator = new QueryPlanRiskEvaluator(adapter);
    const risk = await evaluator.evaluateRisk(query, 'postgres', fastThresholds);

    expect(risk.severity).toBe('MEDIUM_CAUTION');
    expect(risk.isVerifiable).toBe(false);
    expect(risk.warnings.some((w) => w.includes('tiempo de espera'))).toBe(true);
  });
});
