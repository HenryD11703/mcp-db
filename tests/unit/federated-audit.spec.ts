import { describe, expect, it } from 'vitest';
import type { AuditLogEntry, IAuditLogger } from '../../src/contracts/audit.contract.js';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult
} from '../../src/contracts/database-adapter.js';
import { AdapterRegistry } from '../../src/core/engine-registry.js';
import { FederatedQueryOrchestrator } from '../../src/core/federation/federated-orchestrator.js';

class MockAuditLogger implements IAuditLogger {
  public readonly events: AuditLogEntry[] = [];
  private seq = 1;

  public async logEvent(
    event: Omit<AuditLogEntry, 'sequenceNumber' | 'previousHash' | 'entryHash'>
  ): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      ...event,
      sequenceNumber: this.seq++,
      previousHash: 'mock-prev',
      entryHash: 'mock-hash'
    };
    this.events.push(entry);
    return entry;
  }

  public getCurrentSequenceNumber(): number {
    return this.seq;
  }
  public getLatestHash(): string {
    return 'mock-latest';
  }
  public async close(): Promise<void> {}
}

function createAuditTestAdapter(adapterId: string, dialect: 'postgres' | 'tsql'): DatabaseAdapter {
  return {
    adapterId,
    dialect,
    async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
      return { isReadOnly: true, principalName: 'mcp_ro', sessionReadOnlyEnforced: true, violations: [], checkedAt: '' };
    },
    async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
      return { hasFullScan: false, hasUnconditionalJoin: false, estimatedRows: 2, estimatedCost: 1 };
    },
    async executeQuery(): Promise<QueryExecutionResult> {
      return {
        columns: [{ name: 'id', dataType: 'varchar' }],
        rows: [{ id: 'KEY_100' }, { id: 'KEY_200' }],
        rowCount: 2,
        durationMs: 3
      };
    },
    async introspectSchema() {
      return { databaseName: adapterId, dialect, tables: [], foreignKeys: [], inspectedAt: '' };
    },
    async close() {}
  };
}

describe('Federated Structured Audit Logging (User Story 5 - P2)', () => {
  it('links all federated query milestones under the identical correlationId (federationId)', async () => {
    const registry = new AdapterRegistry();
    registry.registerAdapter(createAuditTestAdapter('src-db', 'postgres'));
    registry.registerAdapter(createAuditTestAdapter('trg-db', 'tsql'));
    await registry.initializeAllWithPreflight();

    const mockLogger = new MockAuditLogger();
    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      auditLogger: mockLogger
    });

    const result = await orchestrator.executeFederatedQuery({
      sourceAdapterId: 'src-db',
      sourceSql: 'SELECT id FROM clientes',
      sourceKeyColumn: 'id',
      targetAdapterId: 'trg-db',
      targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys)',
      targetJoinColumn: 'id'
    });

    expect(result.status).toBe('SUCCESS');
    expect(mockLogger.events.length).toBeGreaterThanOrEqual(5);

    // Every single event must share the exact same correlationId
    for (const evt of mockLogger.events) {
      expect(evt.correlationId).toBe(result.federationId);
    }

    const statuses = mockLogger.events.map((e) => e.status);
    expect(statuses).toContain('FEDERATED_QUERY_INIT');
    expect(statuses).toContain('FEDERATED_STEP_SOURCE');
    expect(statuses).toContain('FEDERATED_KEYS_EXTRACTED');
    expect(statuses).toContain('FEDERATED_STEP_TARGET');
    expect(statuses).toContain('FEDERATED_QUERY_COMPLETE');

    // Never log raw keys
    const extractedEvent = mockLogger.events.find((e) => e.status === 'FEDERATED_KEYS_EXTRACTED');
    expect(extractedEvent).toBeDefined();
    expect(extractedEvent?.evaluatedSql).not.toContain('KEY_100');
    expect(extractedEvent?.evaluatedSql).not.toContain('KEY_200');
  });

  it('records FEDERATED_QUERY_FAILED with the same correlationId on guard rejection', async () => {
    const registry = new AdapterRegistry();
    registry.registerAdapter(createAuditTestAdapter('src-db', 'postgres'));
    registry.registerAdapter(createAuditTestAdapter('trg-db', 'tsql'));
    await registry.initializeAllWithPreflight();

    const mockLogger = new MockAuditLogger();
    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      auditLogger: mockLogger
    });

    await expect(
      orchestrator.executeFederatedQuery({
        sourceAdapterId: 'src-db',
        sourceSql: 'SELECT id FROM clientes',
        sourceKeyColumn: 'id',
        targetAdapterId: 'trg-db',
        targetSqlTemplate: 'SELECT id FROM contratos WHERE id IN (:keys); DROP TABLE contratos;',
        targetJoinColumn: 'id'
      })
    ).rejects.toThrow();

    const failedEvent = mockLogger.events.find((e) => e.status === 'FEDERATED_QUERY_FAILED');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.rejectionReason).toContain('Target query guard violation');
    expect(failedEvent?.correlationId).toBe(mockLogger.events[0]?.correlationId);
  });
});
