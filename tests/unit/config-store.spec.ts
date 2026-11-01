import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  redactConnectionString,
  removeConnection,
  upsertConnection
} from '../../src/bin/config-store.js';

describe('config-store (central ~/.db-mcp/config.json)', () => {
  const dir = resolve(process.cwd(), 'tests/fixtures/config-store-temp');
  const file = resolve(dir, 'nested', 'config.json');

  beforeEach(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty config when the file does not exist', () => {
    expect(loadConfig(file)).toEqual({ adapters: [] });
  });

  it('adds, replaces and removes connections', () => {
    expect(upsertConnection(file, { id: 'erp', type: 'postgres', connectionString: 'postgresql://a' }).replaced).toBe(false);
    upsertConnection(file, { id: 'legacy', type: 'sqlserver', connectionString: 'Server=x' });
    expect(upsertConnection(file, { id: 'erp', type: 'postgres', connectionString: 'postgresql://b' }).replaced).toBe(true);

    const cfg = loadConfig(file);
    expect(cfg.adapters.map((a) => a.id)).toEqual(['erp', 'legacy']);
    expect(cfg.adapters[0]?.connectionString).toBe('postgresql://b');

    expect(removeConnection(file, 'legacy')).toBe(true);
    expect(removeConnection(file, 'legacy')).toBe(false);
    expect(loadConfig(file).adapters).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('stores credentials owner-only (0600)', () => {
    upsertConnection(file, { id: 'erp', type: 'postgres', connectionString: 'postgresql://a' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('rejects invalid ids, types and empty connection strings', () => {
    expect(() => upsertConnection(file, { id: 'bad id!', type: 'postgres', connectionString: 'x' })).toThrow(/Identificador/);
    expect(() => upsertConnection(file, { id: 'ok', type: 'mysql' as never, connectionString: 'x' })).toThrow(/Tipo/);
    expect(() => upsertConnection(file, { id: 'ok', type: 'postgres', connectionString: '  ' })).toThrow(/vacía/);
    expect(existsSync(file)).toBe(false);
  });

  it('never overwrites a config file it cannot parse', () => {
    mkdirSync(resolve(dir, 'nested'), { recursive: true });
    writeFileSync(file, '{oops', 'utf8');
    expect(() => upsertConnection(file, { id: 'erp', type: 'postgres', connectionString: 'postgresql://a' })).toThrow(
      /No se pudo leer/
    );
    expect(readFileSync(file, 'utf8')).toBe('{oops');
  });

  it('redacts passwords for display', () => {
    expect(redactConnectionString('postgresql://ro:s3cret@host:5432/db')).toBe('postgresql://ro:***@host:5432/db');
    expect(redactConnectionString('Server=h;User Id=u;Password=s3cret;Database=d')).toBe(
      'Server=h;User Id=u;Password=***;Database=d'
    );
  });
});
