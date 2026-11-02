import { LexicalColumnAnalyzer } from '../security/lexical-column-analyzer.js';
import type { ForeignKeyMetadata, TableMetadata } from '../../contracts/database-adapter.js';
import type {
  CatalogExtras,
  CatalogSnapshot,
  ColumnDetail,
  IGlossaryService,
  ListTablesRequest,
  ListTablesResult,
  QualifiedName,
  TableDetail,
  TableSummary
} from '../../contracts/legacy-discovery.contract.js';
import { parseQualifiedName, resolveTable } from './table-resolution.js';

export type CatalogLoader = (adapterId: string, signal?: AbortSignal) => Promise<CatalogSnapshot>;

export interface CatalogServiceOptions {
  readonly loader: CatalogLoader;
  readonly glossary?: IGlossaryService;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

const INTERNAL_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'sys', 'INFORMATION_SCHEMA']);

/** Converts a user glob (`*`, `?`) into an anchored, case-insensitive RegExp (never SQL). */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .slice(0, 128)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^o:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Catalog browsing built on system-catalog metadata only (no user rows are ever read).
 * Snapshots are cached per adapter with a TTL to keep repeated tool calls cheap.
 */
export class CatalogService {
  private readonly loader: CatalogLoader;
  private readonly glossary: IGlossaryService | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { at: number; snapshot: CatalogSnapshot }>();
  private readonly lexicalAnalyzer = new LexicalColumnAnalyzer();

  constructor(options: CatalogServiceOptions) {
    this.loader = options.loader;
    this.glossary = options.glossary;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  public invalidate(adapterId?: string): void {
    if (adapterId === undefined) {
      this.cache.clear();
    } else {
      this.cache.delete(adapterId);
    }
  }

  public async snapshot(adapterId: string, signal?: AbortSignal): Promise<CatalogSnapshot> {
    const hit = this.cache.get(adapterId);
    if (hit && this.now() - hit.at < this.ttlMs) {
      return hit.snapshot;
    }
    const snapshot = await this.loader(adapterId, signal);
    this.cache.set(adapterId, { at: this.now(), snapshot });
    return snapshot;
  }

  public async listTables(
    adapterId: string,
    request: ListTablesRequest = {},
    signal?: AbortSignal
  ): Promise<ListTablesResult> {
    const { catalog, extras } = await this.snapshot(adapterId, signal);
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, request.limit ?? DEFAULT_LIST_LIMIT));
    const offset = decodeCursor(request.cursor);
    const pattern = request.namePattern ? globToRegExp(request.namePattern) : undefined;
    const schemaFilter = request.schema?.toLowerCase();

    const estimates = this.estimateIndex(extras);
    const filtered = catalog.tables
      .filter((t) => !INTERNAL_SCHEMAS.has(t.schema))
      .filter((t) => (schemaFilter ? t.schema.toLowerCase() === schemaFilter : true))
      .filter((t) => (pattern ? pattern.test(t.name) : true))
      .sort((a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name));

    const page = filtered.slice(offset, offset + limit);
    const tables: TableSummary[] = page.map((t) => this.summary(t, estimates));
    const next = offset + limit < filtered.length ? encodeCursor(offset + limit) : null;
    return { tables, nextCursor: next, total: filtered.length };
  }

  public async describeTable(
    adapterId: string,
    name: { schema?: string; table: string },
    signal?: AbortSignal
  ): Promise<TableDetail> {
    const { catalog, extras } = await this.snapshot(adapterId, signal);
    const table = resolveTable(catalog.tables, name);
    const estimates = this.estimateIndex(extras);

    const colExtras = new Map<string, NonNullable<CatalogExtras['columns']>[number]>();
    for (const c of extras?.columns ?? []) {
      if (c.schema === table.schema && c.table === table.name) {
        colExtras.set(c.column, c);
      }
    }
    const tableIndexes = (extras?.indexes ?? []).filter(
      (i) => i.schema === table.schema && i.table === table.name
    );

    const columns: ColumnDetail[] = table.columns.map((col) => {
      const extra = colExtras.get(col.name);
      const indexNames = tableIndexes.filter((i) => i.columns.includes(col.name)).map((i) => i.indexName);
      const isUnique = tableIndexes.some(
        (i) => i.isUnique && i.columns.length === 1 && i.columns[0] === col.name
      );
      return {
        ...col,
        maxLength: extra?.maxLength ?? null,
        precision: extra?.precision ?? null,
        scale: extra?.scale ?? null,
        defaultExpression: extra?.defaultExpression ?? null,
        isPrimaryKey: table.primaryKeyColumns.includes(col.name),
        isUnique: isUnique || (table.primaryKeyColumns.length === 1 && table.primaryKeyColumns[0] === col.name),
        indexNames,
        isSensitive: this.lexicalAnalyzer.classifyColumn(col.name).isSensitive,
        ...(this.lexicalAnalyzer.classifyColumn(col.name).isSensitive
          ? { sensitiveType: this.lexicalAnalyzer.classifyColumn(col.name).dataType, isMasked: true }
          : { isMasked: false })
      };
    });

    const declaredForeignKeys: ForeignKeyMetadata[] = catalog.foreignKeys.filter(
      (fk) => fk.sourceSchema === table.schema && fk.sourceTable === table.name
    );

    const warnings: string[] = [];
    if (!extras) {
      warnings.push('Engine statistics and index metadata are not available for this adapter.');
    }

    const detail: TableDetail = {
      ...this.summary(table, estimates),
      columns,
      declaredForeignKeys,
      warnings
    };
    return this.glossary ? this.glossary.enrich(detail) : detail;
  }

  public tableNames(catalog: CatalogSnapshot): ReadonlyArray<QualifiedName> {
    return catalog.catalog.tables.map((t) => ({ schema: t.schema, table: t.name }));
  }

  private estimateIndex(extras: CatalogExtras | null): Map<string, number | null> {
    const map = new Map<string, number | null>();
    for (const t of extras?.tables ?? []) {
      map.set(`${t.schema}\u0000${t.table}`, t.estimatedRows);
    }
    return map;
  }

  private summary(table: TableMetadata, estimates: Map<string, number | null>): TableSummary {
    const title = this.glossary?.tableTitle(table.schema, table.name);
    return {
      schema: table.schema,
      table: table.name,
      kind: table.kind,
      estimatedRows: estimates.get(`${table.schema}\u0000${table.name}`) ?? null,
      ...(title ? { glossaryTitle: title } : {})
    };
  }
}

export function parseTableArgument(
  schema: string | undefined,
  table: string
): { schema?: string; table: string } {
  if (schema) {
    return { schema, table };
  }
  return parseQualifiedName(table);
}
