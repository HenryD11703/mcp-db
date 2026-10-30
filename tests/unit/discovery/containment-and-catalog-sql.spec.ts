import { describe, expect, it } from 'vitest';
import { HardenedAstValidator } from '../../../src/core/validation/ast-validator.js';
import { buildContainmentSql, quoteIdentifier } from '../../../src/core/discovery/containment-sql.js';
import { assembleCatalogExtras } from '../../../src/core/discovery/catalog-extras.js';
import {
  TSQL_CATALOG_COLUMNS_SQL,
  TSQL_CATALOG_INDEXES_SQL,
  TSQL_CATALOG_TABLES_SQL
} from '../../../src/adapters/sqlserver/sqlserver-catalog.js';
import {
  PG_CATALOG_COLUMNS_SQL,
  PG_CATALOG_INDEXES_SQL,
  PG_CATALOG_TABLES_SQL
} from '../../../src/adapters/postgres/postgres-catalog.js';

const child = { schema: 'public', table: 'pedidos', column: 'id_cliente' };
const parent = { schema: 'public', table: 'clientes', column: 'id' };

describe('containment probe SQL', () => {
  const validator = new HardenedAstValidator();

  it('is accepted by the read-only AST guard for both dialects', () => {
    for (const dialect of ['postgres', 'tsql'] as const) {
      const sql = buildContainmentSql(dialect, child, parent, 100);
      const verdict = validator.validateSelectOnly(sql, dialect);
      expect(verdict.allowed, `${dialect}: ${sql} -> ${verdict.message}`).toBe(true);
    }
  });

  it('caps the sample inside the engine and projects aggregates only', () => {
    const pg = buildContainmentSql('postgres', child, parent, 100000);
    expect(pg).toContain('LIMIT 100');
    expect(pg).toMatch(/^SELECT COUNT\(\*\)::int AS sampled, COUNT\(p\."id"\)::int AS matched/);
    const ms = buildContainmentSql('tsql', child, parent, 100000);
    expect(ms).toContain('TOP (100)');
    expect(ms).not.toMatch(/SELECT\s+s\.v|SELECT\s+\*/i);
  });

  it('quotes hostile identifiers instead of concatenating them', () => {
    expect(quoteIdentifier('postgres', 'a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
    expect(quoteIdentifier('tsql', 'a]; DROP TABLE x; --')).toBe('[a]]; DROP TABLE x; --]');
    expect(() => quoteIdentifier('postgres', 'bad\u0000name')).toThrow();
    expect(() => quoteIdentifier('tsql', '')).toThrow();
  });
});

describe('catalog SQL', () => {
  it('reads only system catalogs (no user tables, no COUNT(*))', () => {
    const all = [
      PG_CATALOG_TABLES_SQL,
      PG_CATALOG_COLUMNS_SQL,
      PG_CATALOG_INDEXES_SQL,
      TSQL_CATALOG_TABLES_SQL,
      TSQL_CATALOG_COLUMNS_SQL,
      TSQL_CATALOG_INDEXES_SQL
    ];
    for (const sql of all) {
      expect(sql).not.toMatch(/COUNT\s*\(/i);
      expect(sql).toMatch(/pg_catalog|information_schema|sys\./);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|EXEC)\b/i);
    }
  });
});

describe('assembleCatalogExtras', () => {
  it('normalizes estimates, details and multi-column indexes', () => {
    const extras = assembleCatalogExtras(
      [
        { schema_name: 'public', table_name: 'a', estimated_rows: '-1' },
        { schema_name: 'public', table_name: 'b', estimated_rows: '1200' }
      ],
      [
        {
          schema_name: 'public',
          table_name: 'b',
          column_name: 'c',
          max_length: 20,
          precision: null,
          scale: null,
          default_expression: null
        }
      ],
      [
        { schema_name: 'public', table_name: 'b', index_name: 'ix_unique', is_unique: true, is_primary: false, ordinal: 1, column_name: 'c', key_count: 1 },
        { schema_name: 'public', table_name: 'b', index_name: 'ix_comp', is_unique: false, is_primary: false, ordinal: 2, column_name: 'd', key_count: 2 },
        { schema_name: 'public', table_name: 'b', index_name: 'ix_comp', is_unique: false, is_primary: false, ordinal: 1, column_name: 'c', key_count: 2 },
        { schema_name: 'public', table_name: 'b', index_name: 'ix_expr', is_unique: true, is_primary: false, ordinal: 1, column_name: null, key_count: 1 }
      ]
    );
    expect(extras.tables[0]?.estimatedRows).toBeNull();
    expect(extras.tables[1]?.estimatedRows).toBe(1200);
    expect(extras.columns[0]?.maxLength).toBe(20);
    expect(extras.indexes.map((i) => i.indexName).sort()).toEqual(['ix_comp', 'ix_unique']);
    expect(extras.indexes.find((i) => i.indexName === 'ix_comp')?.columns).toEqual(['c', 'd']);
  });
});
