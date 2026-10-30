import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  SchemaCatalog
} from '../../src/contracts/database-adapter.js';
import { AdapterRegistry } from '../../src/core/engine-registry.js';
import { PreflightFatalError, ReadOnlyPrivilegeError } from '../../src/core/errors.js';
import { StartupPreflightGate } from '../../src/core/security/startup-preflight-gate.js';

function createMockAdapter(
  adapterId: string,
  dialect: 'postgres' | 'tsql',
  verification: ReadOnlyVerificationResult
): DatabaseAdapter {
  return {
    adapterId,
    dialect,
    async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
      return verification;
    },
    async analyzeQueryPlan(_query: ParameterizedQuery): Promise<NormalizedRiskProfile> {
      return {
        hasFullScan: false,
        hasUnconditionalJoin: false,
        estimatedRows: 1,
        estimatedCost: 0.01
      };
    },
    async executeQuery(_query: ParameterizedQuery): Promise<QueryExecutionResult> {
      return {
        columns: [{ name: 'id', dataType: 'int' }],
        rows: [{ id: 1 }],
        rowCount: 1,
        durationMs: 1
      };
    },
    async introspectSchema(): Promise<SchemaCatalog> {
      return {
        databaseName: 'test_db',
        dialect,
        tables: [],
        foreignKeys: [],
        inspectedAt: new Date().toISOString()
      };
    },
    async close(): Promise<void> {}
  };
}

describe('StartupPreflightGate (Mandatory Read-Only Startup Check)', () => {
  it('succeeds when all adapters have strictly read-only privileges', async () => {
    const registry = new AdapterRegistry();
    registry.registerAdapter(
      createMockAdapter('pg-readonly', 'postgres', {
        isReadOnly: true,
        principalName: 'mcp_reader',
        sessionReadOnlyEnforced: true,
        violations: [],
        checkedAt: new Date().toISOString()
      })
    );

    const logs: string[] = [];
    const exitSpy = vi.fn();
    const gate = new StartupPreflightGate(registry, {
      logger: (msg) => logs.push(msg),
      exitHandler: exitSpy
    });

    const results = await gate.verifyAndEnforceStartup();
    expect(results.get('pg-readonly')?.isReadOnly).toBe(true);
    expect(gate.getLastSummary()?.allPassed).toBe(true);
    expect(gate.getLastSummary()?.abortedProcess).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('PREFLIGHT_PASSED'))).toBe(true);
  });

  it('aborts startup (fail-closed) in < 2s when write permissions are detected', async () => {
    const registry = new AdapterRegistry();
    registry.registerAdapter(
      createMockAdapter('mssql-writer', 'tsql', {
        isReadOnly: false,
        principalName: 'app_admin',
        sessionReadOnlyEnforced: false,
        violations: [
          'Table dbo.Clientes grants INSERT permission',
          'Principal is member of role db_datawriter'
        ],
        checkedAt: new Date().toISOString()
      })
    );

    const errorLogs: string[] = [];
    const exitSpy = vi.fn();
    const gate = new StartupPreflightGate(registry, {
      errorLogger: (msg) => errorLogs.push(msg),
      exitOnFailure: true,
      exitHandler: exitSpy
    });

    const startTime = performance.now();
    await expect(gate.verifyAndEnforceStartup()).rejects.toThrow(PreflightFatalError);
    const elapsedMs = performance.now() - startTime;

    expect(elapsedMs).toBeLessThan(2000);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(gate.getLastSummary()?.allPassed).toBe(false);
    expect(gate.getLastSummary()?.abortedProcess).toBe(true);
    expect(errorLogs.some((l) => l.includes('db_datawriter'))).toBe(true);
    expect(errorLogs.some((l) => l.includes('INSERT permission'))).toBe(true);
  });

  it('prevents query execution on any adapter that has not passed preflight verification', async () => {
    const registry = new AdapterRegistry();
    registry.registerAdapter(
      createMockAdapter('unverified-pg', 'postgres', {
        isReadOnly: false,
        principalName: 'writer',
        sessionReadOnlyEnforced: false,
        violations: ['Role has UPDATE privilege'],
        checkedAt: new Date().toISOString()
      })
    );

    await expect(registry.initializeAllWithPreflight()).rejects.toThrow(ReadOnlyPrivilegeError);
    expect(registry.isAdapterVerified('unverified-pg')).toBe(false);

    await expect(
      registry.validateAndExecute('unverified-pg', {
        sql: 'SELECT 1',
        params: []
      })
    ).rejects.toThrow(/mandatory read-only preflight verification/);
  });
});
