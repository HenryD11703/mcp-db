import path from 'node:path';
import type {
  ColumnDescriptor,
  ColumnMetadata,
  DatabaseAdapter,
  EngineDialect,
  ForeignKeyMetadata,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  SchemaCatalog,
  TableMetadata
} from '../../contracts/database-adapter.js';
import {
  QueryCancelledError,
  QueryExecutionTimeoutError,
  QueryPlanAnalysisError,
  SqlSecurityRejectionError
} from '../../core/errors.js';
import { HardenedAstValidator } from '../../core/validation/ast-validator.js';
import { verifySqlitePathAndPermissions } from './sqlite-preflight.js';
import { validateSqlitePragma } from './sqlite-security.js';
import { SqliteProcessClient } from './sqlite-process-client.js';

export interface SqliteAdapterOptions {
  readonly adapterId: string;
  readonly filePath: string;
  readonly allowedDirectories: ReadonlyArray<string>;
  /** SQLite busy timeout (waiting on a locked database file). */
  readonly timeoutMs?: number;
  /** Hard ceiling for one statement when the caller supplies no AbortSignal. */
  readonly queryTimeoutMs?: number;
}

/** Node ships `node:sqlite` from 22.5; the options and column metadata used here need 22.16. */
const MIN_NODE = [22, 16] as const;

/** Rows assumed for a scanned relation whose size cannot be read cheaply (views, aliases, CTEs). */
const UNKNOWN_RELATION_ROWS = 1_000;
/** A recursive CTE has no static row bound; treat it as expensive so the cost gate asks for approval. */
const RECURSIVE_ESTIMATED_ROWS = 1_000_000;

export class SqliteAdapter implements DatabaseAdapter {
  public readonly adapterId: string;
  public readonly dialect: EngineDialect = 'sqlite';
  public readonly filePath: string;
  public readonly allowedDirectories: ReadonlyArray<string>;
  private readonly timeoutMs: number;
  private readonly queryTimeoutMs: number;
  private readonly validator = new HardenedAstValidator();
  private client: SqliteProcessClient | null = null;

  constructor(options: SqliteAdapterOptions) {
    this.adapterId = options.adapterId;
    this.filePath = options.filePath;
    this.allowedDirectories = options.allowedDirectories;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 30_000;
  }

  private getClient(): SqliteProcessClient {
    if (!this.client) {
      assertNodeSupportsSqlite();
      const preflight = verifySqlitePathAndPermissions(this.filePath, this.allowedDirectories);
      if (!preflight.isReadOnly) {
        throw new Error(
          `Cannot open SQLite database: preflight checks failed [${preflight.violations.join('; ')}]`
        );
      }
      this.client = new SqliteProcessClient(
        this.adapterId,
        path.resolve(this.filePath),
        this.timeoutMs,
        this.queryTimeoutMs
      );
    }
    return this.client;
  }

  private assertValidSelect(sql: string): void {
    const pragmaCheck = validateSqlitePragma(sql);
    if (!pragmaCheck.allowed) {
      throw new SqlSecurityRejectionError(
        pragmaCheck.reasonCode ?? 'NON_SELECT_ROOT',
        this.dialect,
        pragmaCheck.message
      );
    }

    // A safe schema pragma is allowed directly, without the SELECT AST parser.
    if (/^\s*PRAGMA\s+/i.test(sql)) {
      return;
    }

    const check = this.validator.validateSelectOnly(sql, this.dialect);
    if (!check.allowed) {
      throw new SqlSecurityRejectionError(
        check.reasonCode ?? 'NON_SELECT_ROOT',
        this.dialect,
        check.message
      );
    }
  }

  public async verifyReadOnly(signal?: AbortSignal): Promise<ReadOnlyVerificationResult> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }
    return verifySqlitePathAndPermissions(this.filePath, this.allowedDirectories);
  }

  public async analyzeQueryPlan(query: ParameterizedQuery): Promise<NormalizedRiskProfile> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    try {
      const client = this.getClient();
      const plan = await client.run(
        { sql: `EXPLAIN QUERY PLAN ${query.sql}`, params: query.params.map((p) => p.value) },
        query.signal
      );

      const scannedRelations: string[] = [];
      let hasRecursion = false;
      for (const row of plan.rows) {
        const detail = String(row['detail'] ?? '');
        if (/\bRECURSIVE\b/i.test(detail)) hasRecursion = true;
        // Any SCAN visits every row, even "SCAN t USING COVERING INDEX" (a full index scan).
        const scan = /^SCAN\s+(?:TABLE\s+)?(\S+)/i.exec(detail);
        if (scan && scan[1] && scan[1].toUpperCase() !== 'CONSTANT') {
          scannedRelations.push(scan[1]);
        }
      }

      const sizes: number[] = [];
      for (const relation of scannedRelations) {
        sizes.push(await this.estimateRelationRows(client, relation, query.signal));
      }

      // Scans of several relations in one statement nest, so their row counts multiply.
      let estimatedRows = sizes.length > 0 ? sizes.reduce((acc, n) => acc * n, 1) : 1;
      if (hasRecursion) estimatedRows = Math.max(estimatedRows, RECURSIVE_ESTIMATED_ROWS);

      return {
        estimatedCost: estimatedRows,
        estimatedRows,
        hasFullScan: scannedRelations.length > 0 || hasRecursion,
        hasUnconditionalJoin: scannedRelations.length > 1
      };
    } catch (err) {
      if (query.signal?.aborted || err instanceof QueryCancelledError) {
        throw new QueryCancelledError(this.adapterId);
      }
      if (
        err instanceof QueryPlanAnalysisError ||
        err instanceof QueryExecutionTimeoutError ||
        err instanceof SqlSecurityRejectionError
      ) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Unknown planner error';
      throw new QueryPlanAnalysisError(this.adapterId, msg);
    }
  }

  /** `max(rowid)` is answered from the end of the b-tree, so it is cheap even on huge tables. */
  private async estimateRelationRows(
    client: SqliteProcessClient,
    relation: string,
    signal?: AbortSignal
  ): Promise<number> {
    const quoted = `"${relation.replace(/"/g, '""')}"`;
    try {
      const res = await client.run({ sql: `SELECT max(rowid) AS n FROM ${quoted}`, params: [] }, signal);
      const n = Number(res.rows[0]?.['n']);
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch (err) {
      if (err instanceof QueryCancelledError) throw err;
      return UNKNOWN_RELATION_ROWS;
    }
  }

  public async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const client = this.getClient();
    const startedAt = Date.now();
    const maxRows = typeof query.maxRows === 'number' && query.maxRows > 0 ? query.maxRows : undefined;

    const res = await client.run(
      { sql: query.sql, params: query.params.map((p) => p.value), ...(maxRows ? { maxRows } : {}) },
      query.signal
    );

    const columns: ColumnDescriptor[] =
      res.columns.length > 0
        ? res.columns.map((c) => ({ name: c.name, dataType: c.type || inferType(res.rows[0]?.[c.name]) }))
        : Object.keys(res.rows[0] ?? {}).map((name) => ({ name, dataType: inferType(res.rows[0]?.[name]) }));

    return {
      columns,
      rows: res.rows,
      rowCount: res.rows.length,
      durationMs: Date.now() - startedAt
    };
  }

  public async introspectSchema(signal?: AbortSignal): Promise<SchemaCatalog> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const client = this.getClient();

    const columnRows = (
      await client.run(
        {
          sql: `
            SELECT m.name AS table_name, m.type AS table_type,
                   p.cid AS cid, p.name AS column_name, p.type AS data_type,
                   p."notnull" AS not_null, p.pk AS pk
            FROM sqlite_master m
            JOIN pragma_table_info(m.name) p
            WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
            ORDER BY m.name, p.cid`,
          params: []
        },
        signal
      )
    ).rows;

    const emptyTables = (
      await client.run(
        {
          sql: `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          params: []
        },
        signal
      )
    ).rows;

    const byTable = new Map<string, TableMetadata & { columns: ColumnMetadata[]; pkOrder: Array<[number, string]> }>();
    for (const row of emptyTables) {
      const name = String(row['name']);
      byTable.set(name, {
        schema: 'main',
        name,
        kind: row['type'] === 'view' ? 'VIEW' : 'TABLE',
        columns: [],
        primaryKeyColumns: [],
        pkOrder: []
      });
    }
    for (const row of columnRows) {
      const table = byTable.get(String(row['table_name']));
      if (!table) continue;
      const columnName = String(row['column_name']);
      table.columns.push({
        name: columnName,
        dataType: String(row['data_type'] || 'TEXT'),
        isNullable: Number(row['not_null']) === 0,
        ordinalPosition: Number(row['cid']) + 1
      });
      const pk = Number(row['pk']);
      if (pk > 0) table.pkOrder.push([pk, columnName]);
    }

    const tables: TableMetadata[] = [...byTable.values()].map(({ pkOrder, ...table }) => ({
      ...table,
      // `pk` is the column's position inside a composite key, not its position in the table.
      primaryKeyColumns: pkOrder.sort((a, b) => a[0] - b[0]).map(([, name]) => name)
    }));

    const fkRows = (
      await client.run(
        {
          sql: `
            SELECT m.name AS source_table, f.id AS id, f.seq AS seq,
                   f."table" AS target_table, f."from" AS source_column, f."to" AS target_column
            FROM sqlite_master m
            JOIN pragma_foreign_key_list(m.name) f
            WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
            ORDER BY m.name, f.id, f.seq`,
          params: []
        },
        signal
      )
    ).rows;

    const foreignKeys: ForeignKeyMetadata[] = fkRows.map((fk) => ({
      constraintName: `fk_${String(fk['source_table'])}_${Number(fk['id'])}_${Number(fk['seq'])}`,
      sourceSchema: 'main',
      sourceTable: String(fk['source_table']),
      sourceColumn: String(fk['source_column']),
      targetSchema: 'main',
      targetTable: String(fk['target_table']),
      // A NULL target means "the referenced table's primary key".
      targetColumn: String(
        fk['target_column'] ??
          byTable.get(String(fk['target_table']))?.pkOrder.sort((a, b) => a[0] - b[0])[0]?.[1] ??
          ''
      )
    }));

    return {
      databaseName: path.basename(this.filePath),
      dialect: this.dialect,
      inspectedAt: new Date().toISOString(),
      tables,
      foreignKeys
    };
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}

function inferType(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  if (typeof value === 'bigint') return 'INTEGER';
  if (value instanceof Uint8Array) return 'BLOB';
  return 'TEXT';
}

function assertNodeSupportsSqlite(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new Error(
      `SQLite support needs Node.js >= ${MIN_NODE.join('.')} (built-in node:sqlite); running ${process.versions.node}.`
    );
  }
}
