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
import { SqlSecurityGuard } from '../../src/core/security/sql-security-guard.js';

describe('Adversarial Suite: Second-Order SQL Injection Immunity (Principle III & VI)', () => {
  const ADVERSARIAL_KEY_PAYLOADS = [
    "'; DROP TABLE usuarios; --",
    "' OR '1'='1",
    "' OR 1=1 --",
    "admin'--",
    "'; EXEC xp_cmdshell('dir'); --",
    "' UNION SELECT username, password FROM users --",
    "1; WAITFOR DELAY '0:0:5'--",
    "1'); SELECT pg_sleep(5); --"
  ];

  it('neutralizes all second-order SQL injection attempts via typed parameters into target query', async () => {
    // 1. Source database (compromised or containing adversarial entries)
    const hostileSourceRows = ADVERSARIAL_KEY_PAYLOADS.map((payload, idx) => ({
      key_id: payload,
      label: `Adversarial Entry ${idx + 1}`
    }));

    let capturedTargetQuery: ParameterizedQuery | undefined;

    const sourceAdapter: DatabaseAdapter = {
      adapterId: 'hostile-source-pg',
      dialect: 'postgres',
      async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
        return { isReadOnly: true, principalName: 'mcp_ro', sessionReadOnlyEnforced: true, violations: [], checkedAt: '' };
      },
      async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
        return { hasFullScan: false, hasUnconditionalJoin: false, estimatedRows: hostileSourceRows.length, estimatedCost: 1 };
      },
      async executeQuery(): Promise<QueryExecutionResult> {
        return {
          columns: [{ name: 'key_id', dataType: 'varchar' }, { name: 'label', dataType: 'varchar' }],
          rows: hostileSourceRows,
          rowCount: hostileSourceRows.length,
          durationMs: 2
        };
      },
      async introspectSchema() {
        return { databaseName: 'hostile-source-pg', dialect: 'postgres', tables: [], foreignKeys: [], inspectedAt: '' };
      },
      async close() {}
    };

    const targetAdapter: DatabaseAdapter = {
      adapterId: 'target-db-mssql',
      dialect: 'tsql',
      async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
        return { isReadOnly: true, principalName: 'mcp_ro', sessionReadOnlyEnforced: true, violations: [], checkedAt: '' };
      },
      async analyzeQueryPlan(): Promise<NormalizedRiskProfile> {
        return { hasFullScan: false, hasUnconditionalJoin: false, estimatedRows: 0, estimatedCost: 1 };
      },
      async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
        capturedTargetQuery = query;
        return {
          columns: [{ name: 'target_key', dataType: 'varchar' }, { name: 'detail', dataType: 'varchar' }],
          rows: [],
          rowCount: 0,
          durationMs: 1
        };
      },
      async introspectSchema() {
        return { databaseName: 'target-db-mssql', dialect: 'tsql', tables: [], foreignKeys: [], inspectedAt: '' };
      },
      async close() {}
    };

    const registry = new AdapterRegistry();
    registry.registerAdapter(sourceAdapter);
    registry.registerAdapter(targetAdapter);
    await registry.initializeAllWithPreflight();

    const guard = new SqlSecurityGuard();
    const guardSpy = vi.spyOn(guard, 'validateQuery');

    const orchestrator = new FederatedQueryOrchestrator({
      registry,
      securityGuard: guard
    });

    const result = await orchestrator.executeFederatedQuery({
      sourceAdapterId: 'hostile-source-pg',
      sourceSql: 'SELECT key_id, label FROM audit_records',
      sourceKeyColumn: 'key_id',
      targetAdapterId: 'target-db-mssql',
      targetSqlTemplate: 'SELECT target_key, detail FROM sensitive_inventory WHERE target_key IN (:keys)',
      targetJoinColumn: 'target_key'
    });

    expect(result.status).toBe('SUCCESS');
    expect(capturedTargetQuery).toBeDefined();

    // 1. Verify SQL string contains ZERO payloads concatenated
    const targetSql = capturedTargetQuery!.sql;
    for (const payload of ADVERSARIAL_KEY_PAYLOADS) {
      expect(targetSql.includes(payload)).toBe(false);
    }

    // 2. Verify target SQL strictly has @p1, @p2, ... parameter markers
    expect(targetSql).toBe(
      `SELECT target_key, detail FROM sensitive_inventory WHERE target_key IN (${ADVERSARIAL_KEY_PAYLOADS.map((_, i) => `@p${i + 1}`).join(', ')})`
    );

    // 3. Verify Guard AST validated the expanded target SQL as a safe single-root read-only SELECT
    expect(guardSpy).toHaveBeenCalledWith(targetSql, 'tsql');
    const lastGuardResult = guardSpy.mock.results.slice(-1)[0]?.value;
    expect(lastGuardResult.allowed).toBe(true);

    // 4. Verify parameter values travel safely as isolated literals
    expect(capturedTargetQuery!.params.map((p) => p.value)).toEqual(ADVERSARIAL_KEY_PAYLOADS);
  });
});
