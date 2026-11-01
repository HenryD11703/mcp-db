import { describe, expect, it } from 'vitest';
import { SqlServerAdapter, type SqlServerDriverPool } from '../../src/adapters/sqlserver/sqlserver-adapter.js';

function poolReturning(recordset: Array<Record<string, unknown>>, columnTypes?: Record<string, string>): SqlServerDriverPool {
  return {
    createRequest: () => ({
      input: () => undefined,
      query: async () => ({ recordset, ...(columnTypes ? { columnTypes } : {}) }),
      cancel: () => undefined
    }),
    explainXml: async () => '',
    close: async () => undefined
  };
}

describe('SqlServerAdapter result column types', () => {
  it('reports the driver column types instead of a placeholder', async () => {
    const adapter = new SqlServerAdapter('ms', poolReturning([{ a: 'x', b: 1 }], { a: 'varchar', b: 'int' }));
    const res = await adapter.executeQuery({ sql: 'SELECT a, b FROM t', params: [] });
    expect(res.columns).toEqual([
      { name: 'a', dataType: 'varchar' },
      { name: 'b', dataType: 'int' }
    ]);
  });

  it('still lists the columns of an empty result when the driver provides them', async () => {
    const adapter = new SqlServerAdapter('ms', poolReturning([], { a: 'varchar' }));
    const res = await adapter.executeQuery({ sql: 'SELECT a FROM t WHERE 1 = 0', params: [] });
    expect(res.columns).toEqual([{ name: 'a', dataType: 'varchar' }]);
    expect(res.rowCount).toBe(0);
  });

  it('falls back to the first row and marks the type unknown without driver metadata', async () => {
    const adapter = new SqlServerAdapter('ms', poolReturning([{ a: 1 }]));
    const res = await adapter.executeQuery({ sql: 'SELECT a FROM t', params: [] });
    expect(res.columns).toEqual([{ name: 'a', dataType: 'unknown' }]);
  });
});
