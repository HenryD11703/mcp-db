import { describe, expect, it } from 'vitest';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult
} from '../../src/contracts/database-adapter.js';
import type { EngineRiskThresholds } from '../../src/contracts/cost-limits.contract.js';
import { defaultEngineRiskThresholds } from '../../src/core/limits/default-limits-policy.js';
import { AdapterRegistry } from '../../src/core/engine-registry.js';
import { FederatedQueryOrchestrator } from '../../src/core/federation/federated-orchestrator.js';
import { CostLimitExceededError, ReadOnlyPrivilegeError } from '../../src/core/errors.js';

function createCostMockAdapter(
  adapterId: string,
  dialect: 'postgres' | 'tsql',
  riskProfile: NormalizedRiskProfile,
  isReadOnly: boolean = true
): DatabaseAdapter {
  return {
    adapterId,
    dialect,
    async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
      return {
        isReadOnly,
        principalName: isReadOnly ? 'mcp_ro' : 'mcp_rw',
        sessionReadOnlyEnforced: isReadOnly,
        violations: isReadOnly ? [] : ['INSERT and UPDATE permissions active'],
        checkedAt: new Date().toISOString()
      };
    },
    async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
      return riskProfile;
    },
    async executeQuery(_query: ParameterizedQuery): Promise<QueryExecutionResult> {
      return {
        columns: [{ name: 'id', dataType: 'varchar' }],
        rows: [{ id: '10' }],
        rowCount: 1,
        durationMs: 2
      };
    },
    async introspectSchema() {
      return { databaseName: adapterId, dialect, tables: [], foreignKeys: [], inspectedAt: '' };
    },
    async close() {}
  };
}

describe('Federated Cost Limits & Read-Only Checks (User Story 2 - P1)', () => {
  const strictThresholds: EngineRiskThresholds = {
    ...defaultEngineRiskThresholds,
    maxEstimatedCostCaution: 50,
    maxEstimatedCostBlock: 500,
    maxEstimatedRowsCaution: 100,
    maxEstimatedRowsBlock: 1000
  };

  it('blocks federated query when source query plan exceeds critical cost threshold', async () => {
    const highCostSource = createCostMockAdapter('pg-expensive', 'postgres', {
      hasFullScan: true,
      hasUnconditionalJoin: false,
      estimatedRows: 50000,
      estimatedCost: 1500
    });
    const normalTarget = createCostMockAdapter('mssql-normal', 'tsql', {
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 10,
      estimatedCost: 5
    });

    const registry = new AdapterRegistry();
    registry.registerAdapter(highCostSource);
    registry.registerAdapter(normalTarget);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      engineThresholds: strictThresholds
    });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-expensive',
        sourceSql: 'SELECT id FROM clientes',
        sourceKeyColumn: 'id',
        targetAdapterId: 'mssql-normal',
        targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys)',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow(CostLimitExceededError);
  });

  it('blocks federated query when target query plan requires human approval (caution threshold)', async () => {
    const normalSource = createCostMockAdapter('pg-normal', 'postgres', {
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 5,
      estimatedCost: 2
    });
    const cautionTarget = createCostMockAdapter('mssql-caution', 'tsql', {
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 150,
      estimatedCost: 80 // exceeds caution threshold 50
    });

    const registry = new AdapterRegistry();
    registry.registerAdapter(normalSource);
    registry.registerAdapter(cautionTarget);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      engineThresholds: strictThresholds
    });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-normal',
        sourceSql: 'SELECT id FROM clientes',
        sourceKeyColumn: 'id',
        targetAdapterId: 'mssql-caution',
        targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys)',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow(CostLimitExceededError);
  });

  it('refuses federated query if an adapter has write privileges (read-only preflight gate)', async () => {
    const sourceWithWrite = createCostMockAdapter(
      'pg-write',
      'postgres',
      { hasFullScan: false, hasUnconditionalJoin: false, estimatedRows: 1, estimatedCost: 1 },
      false // NOT read-only
    );
    const normalTarget = createCostMockAdapter('mssql-normal', 'tsql', {
      hasFullScan: false,
      hasUnconditionalJoin: false,
      estimatedRows: 1,
      estimatedCost: 1
    });

    const registry = new AdapterRegistry();
    registry.registerAdapter(sourceWithWrite);
    registry.registerAdapter(normalTarget);

    const orchestrator = new FederatedQueryOrchestrator({ registry });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-write',
        sourceSql: 'SELECT id FROM clientes',
        sourceKeyColumn: 'id',
        targetAdapterId: 'mssql-normal',
        targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys)',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow(ReadOnlyPrivilegeError);
  });
});
