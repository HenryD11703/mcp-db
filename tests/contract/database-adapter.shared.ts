import { describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../src/contracts/database-adapter.js';
import { QueryCancelledError } from '../../src/core/errors.js';

export interface AdapterContractTestFactory {
  /**
   * Creates an adapter connected with a strictly read-only database user.
   */
  createReadOnlyAdapter(): Promise<DatabaseAdapter>;

  /**
   * Creates an adapter connected with a database user that has write privileges
   * (either directly or inherited via roles/public/db_datawriter).
   */
  createWritableUserAdapter(): Promise<DatabaseAdapter>;

  /**
   * Valid SELECT query that triggers a full table scan in the test schema.
   */
  fullScanQuerySql: string;

  /**
   * Valid SELECT query that performs an indexed lookup without full scan or cartesian join.
   */
  indexedLookupQuerySql: string;

  /**
   * Valid SELECT query that triggers an unconditional (cartesian) join.
   */
  unconditionalJoinQuerySql: string;

  /**
   * Valid parameterized SELECT query and its typed parameters.
   */
  parameterizedSelectSql: string;

  /**
   * Long-running SELECT query used to verify native engine cancellation (<1s) via AbortSignal.
   */
  longRunningSelectSql: string;
}

/**
 * Shared Contract Test Suite (`FR-009`, `SC-003`, `SC-004`).
 * Every `DatabaseAdapter` implementation (PostgreSQL, SQL Server, and future engines)
 * MUST pass 100% of these assertions identically.
 */
export function runDatabaseAdapterContractSuite(
  adapterLabel: string,
  factory: AdapterContractTestFactory
): void {
  describe(`DatabaseAdapter Shared Contract Suite: ${adapterLabel}`, () => {
    it('1a. verifyReadOnly() passes when connected user has strictly read-only privileges', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const result = await adapter.verifyReadOnly();
        expect(result.isReadOnly).toBe(true);
        expect(result.violations).toHaveLength(0);
        expect(result.principalName.length).toBeGreaterThan(0);
        expect(() => new Date(result.checkedAt).toISOString()).not.toThrow();
      } finally {
        await adapter.close();
      }
    });

    it('1b. verifyReadOnly() fails and reports violations when user has direct or inherited write privileges', async () => {
      const adapter = await factory.createWritableUserAdapter();
      try {
        const result = await adapter.verifyReadOnly();
        expect(result.isReadOnly).toBe(false);
        expect(result.violations.length).toBeGreaterThan(0);
      } finally {
        await adapter.close();
      }
    });

    it('2a. analyzeQueryPlan() detects full table scan and returns native estimatedCost >= 0', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const profile = await adapter.analyzeQueryPlan({
          sql: factory.fullScanQuerySql,
          params: []
        });
        expect(profile.hasFullScan).toBe(true);
        expect(profile.hasUnconditionalJoin).toBe(false);
        expect(profile.estimatedRows).toBeGreaterThanOrEqual(0);
        expect(profile.estimatedCost).toBeGreaterThanOrEqual(0);
      } finally {
        await adapter.close();
      }
    });

    it('2b. analyzeQueryPlan() detects unconditional cartesian join', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const profile = await adapter.analyzeQueryPlan({
          sql: factory.unconditionalJoinQuerySql,
          params: []
        });
        expect(profile.hasUnconditionalJoin).toBe(true);
        expect(profile.estimatedRows).toBeGreaterThanOrEqual(0);
        expect(profile.estimatedCost).toBeGreaterThanOrEqual(0);
      } finally {
        await adapter.close();
      }
    });

    it('2c. analyzeQueryPlan() reports low-risk indexed lookup accurately', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const profile = await adapter.analyzeQueryPlan({
          sql: factory.indexedLookupQuerySql,
          params: [{ name: 'id', type: 'number', value: 42 }]
        });
        expect(profile.hasFullScan).toBe(false);
        expect(profile.hasUnconditionalJoin).toBe(false);
        expect(profile.estimatedRows).toBeGreaterThanOrEqual(0);
        expect(profile.estimatedCost).toBeGreaterThanOrEqual(0);
      } finally {
        await adapter.close();
      }
    });

    it('3a. executeQuery() executes parameterized SELECT with strictly typed parameters', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const result = await adapter.executeQuery({
          sql: factory.parameterizedSelectSql,
          params: [
            { name: 'estado', type: 'string', value: 'ACTIVO' },
            { name: 'minSaldo', type: 'number', value: 100 }
          ]
        });
        expect(result.rowCount).toBeGreaterThan(0);
        expect(result.rows).toHaveLength(result.rowCount);
        expect(result.columns.length).toBeGreaterThan(0);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        await adapter.close();
      }
    });

    it('3b. executeQuery() natively cancels an active query in the database engine within <1s on AbortSignal (SC-003)', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 80);

        const startedAt = Date.now();
        await expect(
          adapter.executeQuery({
            sql: factory.longRunningSelectSql,
            params: [],
            signal: controller.signal
          })
        ).rejects.toThrow(QueryCancelledError);
        clearTimeout(timer);

        const elapsedAfterAbortMs = Date.now() - startedAt - 80;
        expect(elapsedAfterAbortMs).toBeLessThan(1000);
      } finally {
        await adapter.close();
      }
    });

    it('3c. executeQuery() cleanly rejects when AbortSignal is already aborted before dispatch (race condition)', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const controller = new AbortController();
        controller.abort();

        await expect(
          adapter.executeQuery({
            sql: factory.parameterizedSelectSql,
            params: [],
            signal: controller.signal
          })
        ).rejects.toThrow(QueryCancelledError);
      } finally {
        await adapter.close();
      }
    });

    it('4. introspectSchema() returns normalized SchemaCatalog of tables, views, columns, and foreign keys without reading user table rows', async () => {
      const adapter = await factory.createReadOnlyAdapter();
      try {
        const catalog = await adapter.introspectSchema();
        expect(catalog.databaseName.length).toBeGreaterThan(0);
        expect(catalog.tables.length).toBeGreaterThan(0);

        const clientesTable = catalog.tables.find((t) => t.name === 'clientes');
        expect(clientesTable).toBeDefined();
        expect(clientesTable?.kind).toBe('TABLE');
        expect(clientesTable?.primaryKeyColumns).toContain('id');
        expect(clientesTable?.columns.some((c) => c.name === 'id')).toBe(true);

        expect(catalog.foreignKeys.length).toBeGreaterThan(0);
        expect(
          catalog.foreignKeys.some(
            (fk) => fk.sourceTable === 'pedidos' && fk.targetTable === 'clientes'
          )
        ).toBe(true);
      } finally {
        await adapter.close();
      }
    });
  });
}
