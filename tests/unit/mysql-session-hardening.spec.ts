import { describe, expect, it } from 'vitest';
import { MySqlAdapter, type MySqlDriverPool } from '../../src/adapters/mysql/mysql-adapter.js';
import { MYSQL_PREFLIGHT_QUERY, evaluateMySqlPreflight } from '../../src/adapters/mysql/mysql-preflight.js';

function recordingPool(): { pool: MySqlDriverPool; statements: string[] } {
  const statements: string[] = [];
  const conn = {
    threadId: 7,
    async query(sql: string): Promise<[any, any]> {
      statements.push(sql);
      return [[{ database_name: 'd' }], []];
    },
    release() {}
  };
  const pool: MySqlDriverPool = {
    getConnection: async () => conn,
    execute: async () => [[], []],
    end: async () => {}
  };
  return { pool, statements };
}

describe('MySQL session hardening', () => {
  it('puts the session in READ ONLY before running user SQL', async () => {
    const { pool, statements } = recordingPool();
    const adapter = new MySqlAdapter({ adapterId: 'm', pool });
    await adapter.executeQuery({ sql: 'SELECT 1', params: [] });

    const readOnlyAt = statements.indexOf('SET SESSION TRANSACTION READ ONLY');
    const userSqlAt = statements.indexOf('SELECT 1');
    expect(readOnlyAt).toBeGreaterThanOrEqual(0);
    expect(readOnlyAt).toBeLessThan(userSqlAt);
  });

  it('matches the exact account (user and host) and covers FILE, LOCK TABLES and TRIGGER', () => {
    expect(MYSQL_PREFLIGHT_QUERY).toContain("SUBSTRING_INDEX(CURRENT_USER(), '@', -1)");
    expect(MYSQL_PREFLIGHT_QUERY).not.toMatch(/GRANTEE LIKE/);
    for (const privilege of ["'FILE'", "'LOCK TABLES'", "'TRIGGER'", "'CREATE TEMPORARY TABLES'"]) {
      expect(MYSQL_PREFLIGHT_QUERY).toContain(privilege);
    }
  });

  it('reports a violation when any privilege level grants write access', () => {
    const verdict = evaluateMySqlPreflight({ principal_name: 'u@h', has_global_write: 1 });
    expect(verdict.isReadOnly).toBe(false);
    expect(evaluateMySqlPreflight({ principal_name: 'u@h' }).isReadOnly).toBe(true);
  });
});
