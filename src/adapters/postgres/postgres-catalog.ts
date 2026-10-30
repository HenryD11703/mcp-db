import type { CatalogExtras } from '../../contracts/legacy-discovery.contract.js';
import { assembleCatalogExtras } from '../../core/discovery/catalog-extras.js';

const EXCLUDED_SCHEMAS = `('pg_catalog', 'information_schema')`;

/** Row estimates come from planner statistics (`reltuples`), never from COUNT(*). */
export const PG_CATALOG_TABLES_SQL = `
  SELECT n.nspname AS schema_name, c.relname AS table_name, c.reltuples::bigint AS estimated_rows
  FROM pg_catalog.pg_class c
  INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'm')
    AND n.nspname NOT IN ${EXCLUDED_SCHEMAS}
    AND n.nspname NOT LIKE 'pg_toast%'
`;

export const PG_CATALOG_COLUMNS_SQL = `
  SELECT
    table_schema AS schema_name,
    table_name AS table_name,
    column_name AS column_name,
    character_maximum_length AS max_length,
    numeric_precision AS precision,
    numeric_scale AS scale,
    column_default AS default_expression
  FROM information_schema.columns
  WHERE table_schema NOT IN ${EXCLUDED_SCHEMAS}
`;

export const PG_CATALOG_INDEXES_SQL = `
  SELECT
    n.nspname AS schema_name,
    t.relname AS table_name,
    i.relname AS index_name,
    ix.indisunique AS is_unique,
    ix.indisprimary AS is_primary,
    ix.indnkeyatts AS key_count,
    k.ord AS ordinal,
    a.attname AS column_name
  FROM pg_catalog.pg_index ix
  INNER JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
  INNER JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
  INNER JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
  CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
  WHERE n.nspname NOT IN ${EXCLUDED_SCHEMAS}
    AND ix.indpred IS NULL
    AND k.ord <= ix.indnkeyatts
`;

export interface PostgresCatalogSession {
  query(sql: string): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

export async function fetchPostgresCatalogExtras(
  session: PostgresCatalogSession
): Promise<CatalogExtras> {
  const tables = await session.query(PG_CATALOG_TABLES_SQL);
  const columns = await session.query(PG_CATALOG_COLUMNS_SQL);
  const indexes = await session.query(PG_CATALOG_INDEXES_SQL);
  return assembleCatalogExtras(tables.rows, columns.rows, indexes.rows);
}
