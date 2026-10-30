import { existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/core/audit/audit-logger.js';
import { AuditVerifier } from '../../src/core/audit/audit-verifier.js';
import { AdapterRegistry } from '../../src/core/engine-registry.js';
import { FederatedQueryOrchestrator } from '../../src/core/federation/federated-orchestrator.js';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  QueryExecutionResult,
  ReadOnlyVerificationResult
} from '../../src/contracts/database-adapter.js';

function createMockAdapter(adapterId: string, dialect: 'postgres' | 'tsql'): DatabaseAdapter {
  return {
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
        estimatedRows: 3,
        estimatedCost: 2
      };
    },
    async executeQuery(): Promise<QueryExecutionResult> {
      return {
        columns: [
          { name: 'id', dataType: 'varchar' },
          { name: 'val', dataType: 'varchar' }
        ],
        rows: [
          { id: 'KEY_001', val: 'A' },
          { id: 'KEY_002', val: 'B' },
          { id: 'KEY_003', val: 'C' }
        ],
        rowCount: 3,
        durationMs: 4
      };
    },
    async introspectSchema() {
      return { databaseName: adapterId, dialect, tables: [], foreignKeys: [], inspectedAt: '' };
    },
    async close() {}
  };
}

describe('Federated Audit Chain Integration (User Story 5 - P2)', () => {
  const testLogPath = resolve(process.cwd(), 'tests/fixtures/test-federated-audit-chain.jsonl');
  const verifier = new AuditVerifier();

  beforeEach(() => {
    if (existsSync(testLogPath)) {
      rmSync(testLogPath, { force: true });
    }
  });

  afterEach(() => {
    if (existsSync(testLogPath)) {
      rmSync(testLogPath, { force: true });
    }
  });

  it('generates an authentic, unbroken Merkle hash chain verified by AuditVerifier', async () => {
    const logger = new AuditLogger({ logFilePath: testLogPath });
    const registry = new AdapterRegistry();
    registry.registerAdapter(createMockAdapter('pg-source', 'postgres'));
    registry.registerAdapter(createMockAdapter('tsql-target', 'tsql'));
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      auditLogger: logger
    });

    const execution = await orchestrator.executeFederatedQuery({
      sourceAdapterId: 'pg-source',
      sourceSql: 'SELECT id, val FROM clientes',
      sourceKeyColumn: 'id',
      targetAdapterId: 'tsql-target',
      targetSqlTemplate: 'SELECT id, val FROM ordenes WHERE id IN (:keys)',
      targetJoinColumn: 'id'
    });

    expect(execution.status).toBe('SUCCESS');
    await logger.close();

    // Verify hash chain using AuditVerifier
    const verification = await verifier.verifyLogFile(testLogPath);
    expect(verification.isValid).toBe(true);
    expect(verification.totalEntries).toBeGreaterThanOrEqual(5);
    expect(verification.violatedEntry).toBeUndefined();

    // Read the log file and verify each line
    const rawContent = readFileSync(testLogPath, 'utf8').trim();
    const lines = rawContent.split('\n').map((l) => JSON.parse(l));

    // All events must share the exact same correlationId
    for (const entry of lines) {
      expect(entry.correlationId).toBe(execution.federationId);
    }

    // Verify statuses sequence
    const statuses = lines.map((l) => l.status);
    expect(statuses).toEqual([
      'FEDERATED_QUERY_INIT',
      'FEDERATED_STEP_SOURCE',
      'FEDERATED_KEYS_EXTRACTED',
      'FEDERATED_STEP_TARGET',
      'FEDERATED_QUERY_COMPLETE'
    ]);

    // Verify no raw keys leaked in evaluatedSql
    const extractedEvent = lines.find((l) => l.status === 'FEDERATED_KEYS_EXTRACTED');
    expect(extractedEvent.evaluatedSql).not.toContain('KEY_001');
    expect(extractedEvent.evaluatedSql).not.toContain('KEY_002');
  });

  it('preserves hash chain validity even when a federated query fails midway', async () => {
    const logger = new AuditLogger({ logFilePath: testLogPath });
    const registry = new AdapterRegistry();
    registry.registerAdapter(createMockAdapter('pg-source', 'postgres'));
    registry.registerAdapter(createMockAdapter('tsql-target', 'tsql'));
    await registry.initializeAllWithPreflight();

    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      auditLogger: logger
    });

    // Target SQL with forbidden statement
    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'pg-source',
        sourceSql: 'SELECT id, val FROM clientes',
        sourceKeyColumn: 'id',
        targetAdapterId: 'tsql-target',
        targetSqlTemplate: 'SELECT id, val FROM ordenes WHERE id IN (:keys); DROP TABLE ordenes;',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow();

    await logger.close();

    const verification = await verifier.verifyLogFile(testLogPath);
    expect(verification.isValid).toBe(true);
    expect(verification.totalEntries).toBeGreaterThanOrEqual(2);

    const rawContent = readFileSync(testLogPath, 'utf8').trim();
    const lines = rawContent.split('\n').map((l) => JSON.parse(l));
    const statuses = lines.map((l) => l.status);
    expect(statuses).toContain('FEDERATED_QUERY_INIT');
    expect(statuses).toContain('FEDERATED_QUERY_FAILED');
  });
});
