import type { CatalogExtras } from '../../contracts/legacy-discovery.contract.js';
import { assembleCatalogExtras } from '../../core/discovery/catalog-extras.js';

/** Row estimates come from partition catalog metadata, never from COUNT(*). */
export const TSQL_CATALOG_TABLES_SQL = `
  SELECT s.name AS schema_name, t.name AS table_name,
         SUM(CASE WHEN p.index_id IN (0, 1) THEN p.[rows] ELSE 0 END) AS estimated_rows
  FROM sys.tables t
  INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
  INNER JOIN sys.partitions p ON p.object_id = t.object_id
  WHERE t.is_ms_shipped = 0
  GROUP BY s.name, t.name
`;

export const TSQL_CATALOG_COLUMNS_SQL = `
  SELECT s.name AS schema_name, o.name AS table_name, c.name AS column_name,
         CASE WHEN c.max_length = -1 THEN NULL
              WHEN ty.name IN ('nchar', 'nvarchar') THEN c.max_length / 2
              ELSE c.max_length END AS max_length,
         c.[precision] AS [precision], c.[scale] AS [scale],
         dc.definition AS default_expression
  FROM sys.columns c
  INNER JOIN sys.objects o ON o.object_id = c.object_id
  INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
  INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
  LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
  WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
`;

export const TSQL_CATALOG_INDEXES_SQL = `
  SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name,
         i.is_unique AS is_unique, i.is_primary_key AS is_primary,
         ic.key_ordinal AS ordinal, c.name AS column_name
  FROM sys.indexes i
  INNER JOIN sys.tables t ON t.object_id = i.object_id
  INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
  INNER JOIN sys.index_columns ic
    ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
  INNER JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE i.type > 0 AND i.has_filter = 0 AND t.is_ms_shipped = 0
`;

export interface SqlServerCatalogRequestFactory {
  createRequest(): {
    query(command: string): Promise<{ recordset: ReadonlyArray<Record<string, unknown>> }>;
  };
}

export async function fetchSqlServerCatalogExtras(
  pool: SqlServerCatalogRequestFactory
): Promise<CatalogExtras> {
  const tables = await pool.createRequest().query(TSQL_CATALOG_TABLES_SQL);
  const columns = await pool.createRequest().query(TSQL_CATALOG_COLUMNS_SQL);
  const indexes = await pool.createRequest().query(TSQL_CATALOG_INDEXES_SQL);
  return assembleCatalogExtras(tables.recordset, columns.recordset, indexes.recordset);
}
