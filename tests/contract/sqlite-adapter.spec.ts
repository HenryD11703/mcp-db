import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../src/adapters/sqlite/sqlite-adapter.js';
import { runDatabaseAdapterContractSuite } from './database-adapter.shared.js';
import { verifySqlitePathAndPermissions } from '../../src/adapters/sqlite/sqlite-preflight.js';
import type { ParameterizedQuery, QueryExecutionResult } from '../../src/contracts/database-adapter.js';
import { QueryCancelledError } from '../../src/core/errors.js';

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
  CREATE VIEW vista_lenta AS SELECT id FROM clientes;
  INSERT INTO clientes VALUES (1, 'Ana'), (2, 'Carlos');
  INSERT INTO pedidos VALUES (101, 1), (102, 2);
  INSERT INTO cuentas VALUES (1, 'ACTIVO', 250.0);
`);
initDb.close();

class TestableSqliteAdapter extends SqliteAdapter {
  public override async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
    if (query.sql.includes('vista_lenta') && query.signal) {
      return new Promise<QueryExecutionResult>((_, reject) => {
        const onAbort = () => reject(new QueryCancelledError(this.adapterId));
        if (query.signal!.aborted) {
          onAbort();
        } else {
          query.signal!.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    return super.executeQuery(query);
  }
}

runDatabaseAdapterContractSuite('SqliteAdapter', {
  createReadOnlyAdapter: async () => {
    return new TestableSqliteAdapter({
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
