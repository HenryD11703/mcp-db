import { describe, expect, it } from 'vitest';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult
} from '../../src/contracts/database-adapter.js';
import { AdapterRegistry } from '../../src/core/engine-registry.js';
import { FederatedQueryOrchestrator } from '../../src/core/federation/federated-orchestrator.js';
import { SessionPseudonymContext } from '../../src/core/security/session-pseudonym.js';
import { DataMaskingEngine } from '../../src/core/security/data-masking-engine.js';

describe('Federated In-Memory Privacy & Masking (User Story 4 - P2)', () => {
  it('joins with raw values in memory then applies pseudonymization and masking before output', async () => {
    const rawDpi = '2458912340101';
    const rawEmail = 'carlos.mendoza@empresa.com.gt';

    const sourceRows = [
      { dpi: rawDpi, correo: rawEmail, departamento: 'Guatemala' }
    ];
    const targetRows = [
      { id_dpi: rawDpi, saldo: 45000, estado_credito: 'AL_DIA' }
    ];

    const sourceAdapter: DatabaseAdapter = {
      adapterId: 'pg-crm',
      dialect: 'postgres',
      async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
        return { isReadOnly: true, principalName: 'mcp_ro', sessionReadOnlyEnforced: true, violations: [], checkedAt: '' };
      },
      async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
        return { hasFullScan: false, hasUnconditionalJoin: false, estimatedRows: 1, estimatedCost: 1 };
      },
      async executeQuery(): Promise<QueryExecutionResult> {
        return {
          columns: [
            { name: 'dpi', dataType: 'varchar' },
            { name: 'correo', dataType: 'varchar' },
            { name: 'departamento', dataType: 'varchar' }
          ],
          rows: sourceRows,
          rowCount: 1,
          durationMs: 2
        };
      },
      async introspectSchema() {
        return { databaseName: 'pg-crm', dialect: 'postgres', tables: [], foreignKeys: [], inspectedAt: '' };
      },
      async close() {}
    };

    const targetAdapter: DatabaseAdapter = {
      adapterId: 'mssql-core',
      dialect: 'tsql',
      async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
        return { isReadOnly: true, principalName: 'mcp_ro', sessionReadOnlyEnforced: true, violations: [], checkedAt: '' };
      },
      async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
        return { hasFullScan: false, hasUnconditionalJoin: false, estimatedRows: 1, estimatedCost: 1 };
      },
      async executeQuery(): Promise<QueryExecutionResult> {
        return {
          columns: [
            { name: 'id_dpi', dataType: 'varchar' },
            { name: 'saldo', dataType: 'numeric' },
            { name: 'estado_credito', dataType: 'varchar' }
          ],
          rows: targetRows,
          rowCount: 1,
          durationMs: 2
        };
      },
      async introspectSchema() {
        return { databaseName: 'mssql-core', dialect: 'tsql', tables: [], foreignKeys: [], inspectedAt: '' };
      },
      async close() {}
    };

    const registry = new AdapterRegistry();
    registry.registerAdapter(sourceAdapter);
    registry.registerAdapter(targetAdapter);
    await registry.initializeAllWithPreflight();

    const pseudonymContext = new SessionPseudonymContext();
    const maskingEngine = new DataMaskingEngine();

    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      pseudonymContext,
      maskingEngine
    });

    const result = await orchestrator.executeFederatedQuery({
      sourceAdapterId: 'pg-crm',
      sourceSql: 'SELECT dpi, correo, departamento FROM clientes',
      sourceKeyColumn: 'dpi',
      targetAdapterId: 'mssql-core',
      targetSqlTemplate: 'SELECT id_dpi, saldo, estado_credito FROM creditos WHERE id_dpi IN (:keys)',
      targetJoinColumn: 'id_dpi',
      joinType: 'INNER'
    });

    expect(result.status).toBe('SUCCESS');
    expect(result.totalMergedRows).toBe(1);

    const mergedRow = result.rows[0]!;

    // 1. Join keys MUST be pseudonymized with pseudo_<16_hex>
    expect(String(mergedRow.dpi)).toMatch(/^pseudo_[0-9a-f]{16}$/);
    expect(String(mergedRow.id_dpi)).toMatch(/^pseudo_[0-9a-f]{16}$/);
    // Keys match between source and target
    expect(mergedRow.dpi).toBe(mergedRow.id_dpi);

    // 2. Raw DPI must NEVER appear in output
    expect(JSON.stringify(result)).not.toContain(rawDpi);

    // 3. Email must be masked by DataMaskingEngine rules (partial masking)
    expect(mergedRow.correo).toBe('c***a@empresa.com.gt');
    expect(JSON.stringify(result)).not.toContain(rawEmail);

    // 4. Non-sensitive columns remain readable
    expect(mergedRow.departamento).toBe('Guatemala');
    expect(mergedRow.estado_credito).toBe('AL_DIA');
  });
});
