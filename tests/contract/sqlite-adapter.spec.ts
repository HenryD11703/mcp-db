import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/adapters/sqlite/sqlite-adapter.js';
import { runDatabaseAdapterContractSuite } from './database-adapter.shared.js';
import { verifySqlitePathAndPermissions } from '../../src/adapters/sqlite/sqlite-preflight.js';

import { QueryExecutionTimeoutError } from '../../src/core/errors.js';

// node:sqlite is scheme-only, so load it through require instead of the bundler's resolver.
const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

describe('SQLite Security & Preflight', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-sqlite-test-'));
  const validDbPath = path.join(tempDir, 'secure.db');

  beforeAll(() => {
    const db = new Database(validDbPath);
    db.exec(`
      CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT);
      CREATE TABLE pedidos (id INTEGER PRIMARY KEY, cliente_id INTEGER REFERENCES clientes(id));
      INSERT INTO clientes VALUES (1, 'Ana'), (2, 'Carlos');
      INSERT INTO pedidos VALUES (10, 1), (20, 2);
    `);
    db.close();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects :memory: database connection', () => {
    const result = verifySqlitePathAndPermissions(':memory:', [tempDir]);
    expect(result.isReadOnly).toBe(false);
    expect(result.violations.some((v) => v.includes(':memory:'))).toBe(true);
  });

  it('rejects file outside allowedDirectories whitelist', () => {
    const forbiddenPath = path.join(os.tmpdir(), 'forbidden.db');
    const result = verifySqlitePathAndPermissions(forbiddenPath, [tempDir]);
    expect(result.isReadOnly).toBe(false);
    expect(result.violations.some((v) => v.includes('whitelist') || v.includes('allowed'))).toBe(true);
  });

  it('allows file inside allowedDirectories whitelist', () => {
    const result = verifySqlitePathAndPermissions(validDbPath, [tempDir]);
    expect(result.isReadOnly).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

const suiteTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-sqlite-suite-'));
const suiteDbPath = path.join(suiteTempDir, 'suite.db');

const initDb = new Database(suiteDbPath);
initDb.exec(`
  CREATE TABLE clientes (
    id INTEGER PRIMARY KEY,
    nombre TEXT
  );
  CREATE TABLE pedidos (
    id INTEGER PRIMARY KEY,
    cliente_id INTEGER,
    FOREIGN KEY(cliente_id) REFERENCES clientes(id)
  );
  CREATE TABLE cuentas (
    id INTEGER PRIMARY KEY,
    estado TEXT,
    saldo REAL
  );
  CREATE VIEW vista_lenta AS WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) AS id FROM c;
  INSERT INTO clientes VALUES (1, 'Ana'), (2, 'Carlos');
  INSERT INTO pedidos VALUES (101, 1), (102, 2);
  INSERT INTO cuentas VALUES (1, 'ACTIVO', 250.0);
`);
initDb.close();

runDatabaseAdapterContractSuite('SqliteAdapter', {
  createReadOnlyAdapter: async () => {
    return new SqliteAdapter({
      adapterId: 'sqlite-test-ro',
      filePath: suiteDbPath,
      allowedDirectories: [suiteTempDir]
    });
  },
  createWritableUserAdapter: async () => {
    return new SqliteAdapter({
      adapterId: 'sqlite-test-unauthorized',
      filePath: path.join(os.tmpdir(), 'outside_whitelist.db'),
      allowedDirectories: [suiteTempDir]
    });
  },
  fullScanQuerySql: 'SELECT id FROM clientes',
  indexedLookupQuerySql: 'SELECT id FROM clientes WHERE id = ?',
  unconditionalJoinQuerySql: 'SELECT clientes.id FROM clientes, pedidos',
  parameterizedSelectSql: 'SELECT id, estado, saldo FROM cuentas WHERE estado = ? AND saldo >= ?',
  longRunningSelectSql: 'SELECT id FROM vista_lenta'
});

describe('SQLite hardening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-sqlite-hardening-'));
  const dbPath = path.join(dir, 'h.db');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'db-mcp-sqlite-outside-'));
  const outsideDb = path.join(outside, 'secret.db');

  beforeAll(() => {
    for (const file of [dbPath, outsideDb]) {
      const db = new Database(file);
      db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
        INSERT INTO t (id, v) SELECT i, 'x' FROM n;`);
      db.close();
    }
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const make = (extra: Partial<ConstructorParameters<typeof SqliteAdapter>[0]> = {}) =>
    new SqliteAdapter({ adapterId: 'h', filePath: dbPath, allowedDirectories: [dir], ...extra });

  it('rejects a symlink inside an allowed directory that points outside it', () => {
    const link = path.join(dir, 'link.db');
    fs.symlinkSync(outsideDb, link);
    const result = verifySqlitePathAndPermissions(link, [dir]);
    expect(result.isReadOnly).toBe(false);
    expect(result.violations.join(' ')).toMatch(/whitelist|allowed/);
  });

  it('terminates a runaway statement with the backstop timeout instead of freezing the server', async () => {
    const adapter = make({ queryTimeoutMs: 300 });
    try {
      const startedAt = Date.now();
      await expect(
        adapter.executeQuery({
          sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
          params: []
        })
      ).rejects.toThrow(QueryExecutionTimeoutError);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      // The worker is respawned and the adapter keeps working afterwards.
      const ok = await adapter.executeQuery({ sql: 'SELECT count(*) AS n FROM t', params: [] });
      expect(ok.rows[0]).toEqual({ n: 5000 });
    } finally {
      await adapter.close();
    }
  });

  it('caps rows while streaming instead of materialising the whole result', async () => {
    const adapter = make();
    try {
      const res = await adapter.executeQuery({ sql: 'SELECT id FROM t', params: [], maxRows: 10 });
      expect(res.rowCount).toBe(10);
    } finally {
      await adapter.close();
    }
  });

  it('prices a scan by table size and flags unbounded recursion as expensive', async () => {
    const adapter = make();
    try {
      const scan = await adapter.analyzeQueryPlan({ sql: 'SELECT v FROM t', params: [] });
      expect(scan.hasFullScan).toBe(true);
      expect(scan.estimatedRows).toBe(5000);

      const recursive = await adapter.analyzeQueryPlan({
        sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
        params: []
      });
      expect(recursive.estimatedRows).toBeGreaterThanOrEqual(1_000_000);
    } finally {
      await adapter.close();
    }
  });

  it.each(["SELECT randomblob(1000000000)", "SELECT zeroblob(1000000000)", "SELECT load_extension('x')"])(
    'blocks memory/extension functions: %s',
    async (sql) => {
      const adapter = make();
      try {
        await expect(adapter.executeQuery({ sql, params: [] })).rejects.toThrow();
      } finally {
        await adapter.close();
      }
    }
  );

  it('orders composite primary keys by their position in the key', async () => {
    const compositeDb = path.join(dir, 'c.db');
    const db = new Database(compositeDb);
    db.exec('CREATE TABLE e (b INTEGER, a INTEGER, PRIMARY KEY (a, b))');
    db.close();
    const adapter = new SqliteAdapter({ adapterId: 'c', filePath: compositeDb, allowedDirectories: [dir] });
    try {
      const catalog = await adapter.introspectSchema();
      expect(catalog.tables.find((t) => t.name === 'e')?.primaryKeyColumns).toEqual(['a', 'b']);
    } finally {
      await adapter.close();
    }
  });
});
