import { describe, expect, it, vi } from 'vitest';
import { CatalogService, globToRegExp } from '../../../src/core/discovery/catalog-service.js';
import {
  parseQualifiedName,
  resolveTable,
  TableResolutionError
} from '../../../src/core/discovery/table-resolution.js';
import { LEGACY_TABLES, snapshotOf, table } from '../../fixtures/legacy-schemas.js';

describe('catalog service', () => {
  it('caches snapshots until the TTL expires', async () => {
    let now = 0;
    const loader = vi.fn(async () => snapshotOf(LEGACY_TABLES));
    const svc = new CatalogService({ loader, ttlMs: 1000, now: () => now });
    await svc.listTables('a');
    await svc.listTables('a');
    expect(loader).toHaveBeenCalledTimes(1);
    now = 2000;
    await svc.listTables('a');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('filters by schema and glob and excludes internal schemas', async () => {
    const tables = [
      table('a', [['id', 'int']], ['id'], 'ventas'),
      table('b', [['id', 'int']], ['id'], 'seguridad'),
      table('pg_class', [['oid', 'int']], [], 'pg_catalog')
    ];
    const svc = new CatalogService({ loader: async () => snapshotOf(tables) });
    const all = await svc.listTables('x');
    expect(all.tables.map((t) => t.schema).sort()).toEqual(['seguridad', 'ventas']);
    const ventas = await svc.listTables('x', { schema: 'VENTAS' });
    expect(ventas.tables).toHaveLength(1);
    expect(ventas.tables[0]?.table).toBe('a');
  });

  it('handles very large catalogs with bounded pages (10k tables)', async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => table(`t_${i}`, [['id', 'int']], ['id']));
    const svc = new CatalogService({ loader: async () => snapshotOf(many) });
    const started = Date.now();
    const page = await svc.listTables('x', { limit: 500, namePattern: 't_9*' });
    expect(page.tables.length).toBe(500);
    expect(page.nextCursor).toBeTruthy();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('describes columns with keys and flags missing engine metadata', async () => {
    const svc = new CatalogService({ loader: async () => snapshotOf(LEGACY_TABLES) });
    const detail = await svc.describeTable('x', { table: 'pedidos' });
    expect(detail.columns.find((c) => c.name === 'id')?.isPrimaryKey).toBe(true);
    expect(detail.columns.find((c) => c.name === 'status')?.isPrimaryKey).toBe(false);
    expect(detail.warnings.join(' ')).toContain('not available');
  });

  it('resolves names case-insensitively and rejects ambiguity', async () => {
    const tables = [
      table('Clientes', [['id', 'int']], ['id'], 'ventas'),
      table('clientes', [['id', 'int']], ['id'], 'soporte')
    ];
    expect(resolveTable(tables, { schema: 'ventas', table: 'CLIENTES' }).schema).toBe('ventas');
    expect(() => resolveTable(tables, { table: 'clientes' })).not.toThrow(); // exact-case wins
    expect(() => resolveTable(tables, { table: 'CLIENTES' })).toThrow(TableResolutionError);
    expect(() => resolveTable(tables, { table: 'nada' })).toThrow(/not found/);
    expect(parseQualifiedName('ventas.facturas')).toEqual({ schema: 'ventas', table: 'facturas' });
  });
});

describe('glob handling', () => {
  it('translates * and ? and escapes regex metacharacters', () => {
    expect(globToRegExp('cli*').test('clientes')).toBe(true);
    expect(globToRegExp('c?i').test('cli')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('(a+)+$').test('aaaaaaaaaaaaaaaaaaaaaaaa!')).toBe(false);
  });
});
