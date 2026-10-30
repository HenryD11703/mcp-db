import type {
  CatalogColumnExtra,
  CatalogExtras,
  CatalogIndexExtra,
  CatalogTableExtra
} from '../../contracts/legacy-discovery.contract.js';

type Row = Readonly<Record<string, unknown>>;

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

/**
 * Normalizes raw catalog rows (engine-specific SQL) into the common CatalogExtras shape.
 * Negative row estimates (e.g. PostgreSQL `-1` = never analyzed) become `null`.
 */
export function assembleCatalogExtras(
  tableRows: ReadonlyArray<Row>,
  columnRows: ReadonlyArray<Row>,
  indexRows: ReadonlyArray<Row>
): CatalogExtras {
  const tables: CatalogTableExtra[] = tableRows.map((r) => {
    const est = toNumberOrNull(r['estimated_rows']);
    return {
      schema: String(r['schema_name'] ?? ''),
      table: String(r['table_name'] ?? ''),
      estimatedRows: est === null || est < 0 ? null : est
    };
  });

  const columns: CatalogColumnExtra[] = columnRows.map((r) => ({
    schema: String(r['schema_name'] ?? ''),
    table: String(r['table_name'] ?? ''),
    column: String(r['column_name'] ?? ''),
    maxLength: toNumberOrNull(r['max_length']),
    precision: toNumberOrNull(r['precision']),
    scale: toNumberOrNull(r['scale']),
    defaultExpression:
      r['default_expression'] === null || r['default_expression'] === undefined
        ? null
        : String(r['default_expression'])
  }));

  interface IndexAcc {
    schema: string;
    table: string;
    indexName: string;
    isUnique: boolean;
    isPrimary: boolean;
    keyCount: number | null;
    cols: Array<{ ord: number; name: string | null }>;
  }
  const accs = new Map<string, IndexAcc>();
  for (const r of indexRows) {
    const schema = String(r['schema_name'] ?? '');
    const table = String(r['table_name'] ?? '');
    const indexName = String(r['index_name'] ?? '');
    const key = `${schema}\u0000${table}\u0000${indexName}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = {
        schema,
        table,
        indexName,
        isUnique: toBool(r['is_unique']),
        isPrimary: toBool(r['is_primary']),
        keyCount: toNumberOrNull(r['key_count']),
        cols: []
      };
      accs.set(key, acc);
    }
    acc.cols.push({
      ord: toNumberOrNull(r['ordinal']) ?? acc.cols.length + 1,
      name: r['column_name'] === null || r['column_name'] === undefined ? null : String(r['column_name'])
    });
  }

  const indexes: CatalogIndexExtra[] = [];
  for (const acc of accs.values()) {
    // Expression indexes expose a null column or fewer named columns than key parts:
    // they cannot be used as plain key candidates, so they are dropped.
    if (acc.cols.some((c) => c.name === null)) {
      continue;
    }
    if (acc.keyCount !== null && acc.cols.length !== acc.keyCount) {
      continue;
    }
    const ordered = [...acc.cols].sort((a, b) => a.ord - b.ord).map((c) => c.name as string);
    indexes.push({
      schema: acc.schema,
      table: acc.table,
      indexName: acc.indexName,
      isUnique: acc.isUnique,
      isPrimary: acc.isPrimary,
      columns: ordered
    });
  }

  return { tables, columns, indexes };
}
