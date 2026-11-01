import { describe, expect, it } from 'vitest';
import { PostgresAdapter, type PostgresDriverPool } from '../../src/adapters/postgres/postgres-adapter.js';
import { SqlServerAdapter, type SqlServerDriverPool } from '../../src/adapters/sqlserver/sqlserver-adapter.js';
import { isCatalogCapable } from '../../src/contracts/legacy-discovery.contract.js';
import { QueryCancelledError } from '../../src/core/errors.js';

const child = { schema: 'public', table: 'pedidos', column: 'id_cliente' };
const parent = { schema: 'public', table: 'clientes', column: 'id' };

function pgPool(
  responder: (sql: string) => Array<Record<string, unknown>>,
  seen: string[]
): PostgresDriverPool {
  return {
    async connect() {
      return {
        processID: 1,
        async query(sql: string) {
          seen.push(sql);
          return { rows: responder(sql) };
        },
        release() {}
      };
    },
    async cancelBackend() {},
    async end() {}
  };
}

function mssqlPool(
  responder: (sql: string) => Array<Record<string, unknown>>,
  seen: string[]
): SqlServerDriverPool {
  return {
    createRequest() {
      return {
        input() {},
        async query(command: string) {
          seen.push(command);
          return { recordset: responder(command) };
        },
        cancel() {}
      };
    },
    async explainXml() {
      return '';
    },
    async close() {}
  };
}

describe('catalog capabilities of engine adapters', () => {
  it('PostgresAdapter exposes catalog extras and aggregate-only sampling through the guard', async () => {
    const seen: string[] = [];
    const adapter = new PostgresAdapter(
      'pg',
      pgPool((sql) => (sql.includes('COUNT(*)::int') ? [{ sampled: 20, matched: 18 }] : []), seen)
    );
    expect(isCatalogCapable(adapter)).toBe(true);

    const evidence = await adapter.sampleContainment(child, parent, { maxSample: 500 });
    expect(evidence).toEqual({ sampled: 20, matched: 18 });
    expect(seen[0]).toContain('LIMIT 100');

    await adapter.getCatalogExtras();
    expect(seen.some((s) => s.includes('pg_class'))).toBe(true);
    expect(seen.some((s) => s.includes('pg_index'))).toBe(true);
  });

  it('PostgresAdapter sampling honors cancellation', async () => {
    const adapter = new PostgresAdapter('pg', pgPool(() => [], []));
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.sampleContainment(child, parent, { maxSample: 10, signal: controller.signal })
    ).rejects.toThrow(QueryCancelledError);
  });

  it('SqlServerAdapter exposes catalog extras and aggregate-only sampling through the guard', async () => {
    const seen: string[] = [];
    const adapter = new SqlServerAdapter(
      'ms',
      mssqlPool((sql) => (sql.includes('TOP (100)') ? [{ sampled: 7, matched: 7 }] : []), seen)
    );
    expect(isCatalogCapable(adapter)).toBe(true);

    const evidence = await adapter.sampleContainment(child, parent, { maxSample: 5000 });
    expect(evidence).toEqual({ sampled: 7, matched: 7 });

    const extras = await adapter.getCatalogExtras();
    expect(extras.tables).toEqual([]);
    expect(seen.some((s) => s.includes('sys.partitions'))).toBe(true);
  });
});
