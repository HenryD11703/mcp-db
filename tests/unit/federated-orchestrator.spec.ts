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

function createMockAdapter(
  adapterId: string,
  dialect: 'postgres' | 'tsql',
  rows: Array<Record<string, unknown>>,
  columns: Array<{ name: string; dataType: string }> = []
): { adapter: DatabaseAdapter; executeSpy: ReturnType<typeof vi.fn> } {
  const executeSpy = vi.fn(async (_query: ParameterizedQuery): Promise<QueryExecutionResult> => {
    return {
      columns: columns.length > 0 ? columns : Object.keys(rows[0] ?? {}).map((name) => ({ name, dataType: 'varchar' })),
      rows,
      rowCount: rows.length,
      durationMs: 5
    };
  });

  const adapter: DatabaseAdapter = {
    adapterId,
    dialect,
    async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
      return {
        isReadOnly: true,
        principalName: 'mcp_ro_user',
        sessionReadOnlyEnforced: true,
        violations: [],
        checkedAt: new Date().toISOString()
      };
    },
    async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
      return {
        hasFullScan: false,
        hasUnconditionalJoin: false,
        estimatedRows: rows.length,
        estimatedCost: 1.0
      };
    },
    executeQuery: executeSpy,
    async introspectSchema() {
      return {
        databaseName: adapterId,
        dialect,
        tables: [],
        foreignKeys: [],
        inspectedAt: new Date().toISOString()
      };
    },
    async close() {}
  };

  return { adapter, executeSpy };
}

describe('FederatedQueryOrchestrator (User Story 1 - P1 MVP)', () => {
  it('executes federated query between PostgreSQL (source) and SQL Server (target)', async () => {
    const sourceRows = [
      { cliente_id: 'C100', nombre: 'Acme Corp', region: 'NORTE' },
      { cliente_id: 'C200', nombre: 'Beta LLC', region: 'SUR' }
    ];
    const targetRows = [
      { id_cliente: 'C100', contrato_id: 'CTR-01', monto: 1500 },
      { id_cliente: 'C200', contrato_id: 'CTR-02', monto: 3200 }
    ];

    const source = createMockAdapter('pg-source', 'postgres', sourceRows);
    const target = createMockAdapter('mssql-target', 'tsql', targetRows);

    const registry = new AdapterRegistry();
    registry.registerAdapter(source.adapter);
    registry.registerAdapter(target.adapter);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({ registry });

    const result = await orchestrator.executeFederatedQuery({
      sourceAdapterId: 'pg-source',
      sourceSql: 'SELECT cliente_id, nombre, region FROM clientes',
      sourceKeyColumn: 'cliente_id',
      targetAdapterId: 'mssql-target',
      targetSqlTemplate: 'SELECT id_cliente, contrato_id, monto FROM contratos WHERE id_cliente IN (:keys)',
      targetJoinColumn: 'id_cliente',
      joinType: 'LEFT'
    });

    // Check target executed with expanded typed parameter markers (@p1, @p2 for T-SQL)
    expect(target.executeSpy).toHaveBeenCalledTimes(1);
    const targetQueryPassed = target.executeSpy.mock.calls[0]?.[0] as ParameterizedQuery;
    expect(targetQueryPassed.sql).toBe(
      'SELECT id_cliente, contrato_id, monto FROM contratos WHERE id_cliente IN (@p1, @p2)'
    );
    expect(targetQueryPassed.params.map((p) => p.value)).toEqual(['C100', 'C200']);

    // Check result
    expect(result.status).toBe('SUCCESS');
    expect(result.totalSourceRows).toBe(2);
    expect(result.totalTargetRows).toBe(2);
    expect(result.totalMergedRows).toBe(2);
    expect(result.keysProcessed).toBe(2);
    expect(result.rows).toHaveLength(2);

    // Check that join key columns were pseudonymized with pseudo_<16_hex>
    const firstRow = result.rows[0]!;
    expect(String(firstRow.cliente_id)).toMatch(/^pseudo_[0-9a-f]{16}$/);
    expect(String(firstRow.id_cliente)).toMatch(/^pseudo_[0-9a-f]{16}$/);
    // Identical keys in source and target have matching pseudonym
    expect(firstRow.cliente_id).toBe(firstRow.id_cliente);
    // Non-key columns retained
    expect(firstRow.nombre).toBe('Acme Corp');
    expect(firstRow.contrato_id).toBe('CTR-01');
  });

  it('optimizes empty source results by skipping BD B execution completely (FR-005)', async () => {
    const source = createMockAdapter('pg-source-empty', 'postgres', []);
    const target = createMockAdapter('mssql-target-skipped', 'tsql', [{ id: 1 }]);

    const registry = new AdapterRegistry();
    registry.registerAdapter(source.adapter);
    registry.registerAdapter(target.adapter);
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({ registry });

    const result = await orchestrator.executeFederatedQuery({
      sourceAdapterId: 'pg-source-empty',
      sourceSql: 'SELECT cliente_id FROM clientes WHERE 1 = 0',
      sourceKeyColumn: 'cliente_id',
      targetAdapterId: 'mssql-target-skipped',
      targetSqlTemplate: 'SELECT id_cliente FROM contratos WHERE id_cliente IN (:keys)',
      targetJoinColumn: 'id_cliente'
    });

    expect(result.status).toBe('EMPTY_SOURCE');
    expect(result.totalSourceRows).toBe(0);
    expect(result.totalMergedRows).toBe(0);
    expect(source.executeSpy).toHaveBeenCalledTimes(1);
    // Target query was NOT executed
    expect(target.executeSpy).not.toHaveBeenCalled();
    expect(result.warnings?.[0]).toContain('Source query returned 0 valid keys');
  });
});
