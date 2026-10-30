import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult
} from '../../src/contracts/database-adapter.js';
import { AdapterRegistry } from '../../src/core/engine-registry.js';
import { FederatedQueryOrchestrator } from '../../src/core/federation/federated-orchestrator.js';
import { SqlSecurityViolationError } from '../../src/core/errors.js';

function createMockAdapter(adapterId: string, dialect: 'postgres' | 'tsql'): DatabaseAdapter {
  return {
    adapterId,
    dialect,
    async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
      return {
        isReadOnly: true,
        principalName: 'mcp_ro',
        sessionReadOnlyEnforced: true,
        violations: [],
        checkedAt: new Date().toISOString()
      };
    },
    async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
      return { hasFullScan: false, hasUnconditionalJoin: false, estimatedRows: 1, estimatedCost: 1 };
    },
    async executeQuery(_query: ParameterizedQuery): Promise<QueryExecutionResult> {
      return {
        columns: [{ name: 'id', dataType: 'varchar' }],
        rows: [{ id: '1' }],
        rowCount: 1,
        durationMs: 1
      };
    },
    async introspectSchema() {
      return { databaseName: adapterId, dialect, tables: [], foreignKeys: [], inspectedAt: '' };
    },
    async close() {}
  };
}

describe('Federated Guard AST Independent Validation (User Story 2 - P1)', () => {
  it('rejects mutating source query via Guard AST before executing on source database', async () => {
    const source = createMockAdapter('pg-src', 'postgres');
    const target = createMockAdapter('mssql-trg', 'tsql');
    const executeSpy = vi.spyOn(source, 'executeQuery');

    const registry = new AdapterRegistry();
    registry.registerAdapter(source);
    registry.registerAdapter(target);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({ registry });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-src',
        sourceSql: 'UPDATE clientes SET activo = false WHERE id = 1',
        sourceKeyColumn: 'id',
        targetAdapterId: 'mssql-trg',
        targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys)',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow(SqlSecurityViolationError);

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('rejects source query containing inline comments (-- comment)', async () => {
    const source = createMockAdapter('pg-src', 'postgres');
    const target = createMockAdapter('mssql-trg', 'tsql');

    const registry = new AdapterRegistry();
    registry.registerAdapter(source);
    registry.registerAdapter(target);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({ registry });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-src',
        sourceSql: 'SELECT id FROM clientes -- inline comment',
        sourceKeyColumn: 'id',
        targetAdapterId: 'mssql-trg',
        targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys)',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow(SqlSecurityViolationError);
  });

  it('rejects target query containing stacked commands (; DROP TABLE) before target execution', async () => {
    const source = createMockAdapter('pg-src', 'postgres');
    const target = createMockAdapter('mssql-trg', 'tsql');
    const targetSpy = vi.spyOn(target, 'executeQuery');

    const registry = new AdapterRegistry();
    registry.registerAdapter(source);
    registry.registerAdapter(target);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({ registry });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-src',
        sourceSql: 'SELECT id FROM clientes',
        sourceKeyColumn: 'id',
        targetAdapterId: 'mssql-trg',
        targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys); DROP TABLE auditoria;',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow(SqlSecurityViolationError);

    expect(targetSpy).not.toHaveBeenCalled();
  });

  it('rejects target query containing mutating CTEs (WITH del AS (DELETE...))', async () => {
    const source = createMockAdapter('pg-src', 'postgres');
    const target = createMockAdapter('mssql-trg', 'tsql');

    const registry = new AdapterRegistry();
    registry.registerAdapter(source);
    registry.registerAdapter(target);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({ registry });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-src',
        sourceSql: 'SELECT id FROM clientes',
        sourceKeyColumn: 'id',
        targetAdapterId: 'mssql-trg',
        targetSqlTemplate:
          'WITH del AS (DELETE FROM contratos OUTPUT DELETED.id) SELECT id FROM del WHERE id IN (:keys)',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow(SqlSecurityViolationError);
  });
});
