import Database from 'better-sqlite3';
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
  QueryPlanAnalysisError,
  SqlSecurityRejectionError
} from '../../core/errors.js';
import { HardenedAstValidator } from '../../core/validation/ast-validator.js';
import { verifySqlitePathAndPermissions } from './sqlite-preflight.js';
import { validateSqlitePragma } from './sqlite-security.js';

export interface SqliteAdapterOptions {
  readonly adapterId: string;
  readonly filePath: string;
  readonly allowedDirectories: ReadonlyArray<string>;
  readonly timeoutMs?: number;
}

export class SqliteAdapter implements DatabaseAdapter {
  public readonly adapterId: string;
  public readonly dialect: EngineDialect = 'sqlite';
  public readonly filePath: string;
  public readonly allowedDirectories: ReadonlyArray<string>;
  private readonly timeoutMs: number;
  private readonly validator = new HardenedAstValidator();
  private dbInstance: Database.Database | null = null;

  constructor(options: SqliteAdapterOptions) {
    this.adapterId = options.adapterId;
    this.filePath = options.filePath;
    this.allowedDirectories = options.allowedDirectories;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  protected getDb(): Database.Database {
    if (!this.dbInstance) {
      const preflight = verifySqlitePathAndPermissions(this.filePath, this.allowedDirectories);
      if (!preflight.isReadOnly) {
        throw new Error(
          `Cannot open SQLite database: preflight checks failed [${preflight.violations.join('; ')}]`
        );
      }
      this.dbInstance = new Database(path.resolve(this.filePath), {
        readonly: true,
        fileMustExist: true,
        timeout: this.timeoutMs
      });
      this.dbInstance.pragma('query_only = ON');
    }
    return this.dbInstance;
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

    // If it's a safe pragma, allow it directly without AST SELECT parser
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
      const db = this.getDb();
      const explainSql = `EXPLAIN QUERY PLAN ${query.sql}`;
      const boundValues = query.params.map((p) => p.value);
      const rows = db.prepare(explainSql).all(...boundValues) as Array<{
        id: number;
        parent: number;
        notused: number;
        detail: string;
      }>;

      let hasFullScan = false;
      let scanCount = 0;

      for (const row of rows) {
        const detail = (row.detail ?? '').toUpperCase();
        if (detail.includes('SCAN') && !detail.includes('USING INDEX') && !detail.includes('USING COVERING INDEX')) {
          hasFullScan = true;
          scanCount++;
        }
      }

      const hasUnconditionalJoin = scanCount > 1;

      return {
        estimatedCost: rows.length * 10,
        estimatedRows: rows.length * 100,
        hasFullScan,
        hasUnconditionalJoin
      };
    } catch (err) {
      if (query.signal?.aborted || (err as any)?.code === 'SQLITE_INTERRUPT') {
        throw new QueryCancelledError(this.adapterId);
      }
      if (err instanceof QueryPlanAnalysisError || err instanceof QueryCancelledError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Unknown planner error';
      throw new QueryPlanAnalysisError(this.adapterId, msg);
    }
  }

  public async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const db = this.getDb();
    const startedAt = Date.now();
    let onAbort: (() => void) | undefined;

    try {
      if (query.signal) {
        onAbort = () => {
          (db as any).interrupt?.();
        };
        query.signal.addEventListener('abort', onAbort, { once: true });
      }

      const boundValues = query.params.map((p) => p.value);
      const stmt = db.prepare(query.sql);
      const rawRows = stmt.all(...boundValues) as Array<Record<string, unknown>>;

      let rows = rawRows;
      if (typeof query.maxRows === 'number' && query.maxRows > 0 && rows.length > query.maxRows) {
        rows = rows.slice(0, query.maxRows);
      }

      const columns: ColumnDescriptor[] = [];
      if (stmt.columns) {
        for (const col of stmt.columns()) {
          columns.push({
            name: col.name,
            dataType: col.type ?? 'TEXT'
          });
        }
      } else if (rows[0]) {
        for (const key of Object.keys(rows[0])) {
          columns.push({
            name: key,
            dataType: typeof rows[0][key]
          });
        }
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
        durationMs: Date.now() - startedAt
      };
    } catch (err) {
      if (query.signal?.aborted || (err as any)?.code === 'SQLITE_INTERRUPT') {
        throw new QueryCancelledError(this.adapterId);
      }
      throw err;
    } finally {
      if (query.signal && onAbort) {
        query.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  public async introspectSchema(signal?: AbortSignal): Promise<SchemaCatalog> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const db = this.getDb();
    const tablesSql = `
      SELECT name, type 
      FROM sqlite_master 
      WHERE type IN ('table', 'view') 
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;
    const tableMasterRows = db.prepare(tablesSql).all() as Array<{ name: string; type: string }>;

    const tables: TableMetadata[] = [];
    const allForeignKeys: ForeignKeyMetadata[] = [];

    for (const masterRow of tableMasterRows) {
      const tableName = masterRow.name;
      const tableKind: 'TABLE' | 'VIEW' = masterRow.type === 'view' ? 'VIEW' : 'TABLE';

      const columns: ColumnMetadata[] = [];
      const primaryKeyColumns: string[] = [];

      const colRows = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
        pk: number;
      }>;

      for (const col of colRows) {
        columns.push({
          name: col.name,
          dataType: col.type || 'TEXT',
          isNullable: col.notnull === 0,
          ordinalPosition: col.cid + 1
        });
        if (col.pk > 0) {
          primaryKeyColumns.push(col.name);
        }
      }

      tables.push({
        schema: 'main',
        name: tableName,
        kind: tableKind,
        columns,
        primaryKeyColumns
      });

      const fkRows = db.prepare(`PRAGMA foreign_key_list("${tableName.replace(/"/g, '""')}")`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
      }>;

      for (const fk of fkRows) {
        allForeignKeys.push({
          constraintName: `fk_${tableName}_${fk.id}_${fk.seq}`,
          sourceSchema: 'main',
          sourceTable: tableName,
          sourceColumn: fk.from,
          targetSchema: 'main',
          targetTable: fk.table,
          targetColumn: fk.to
        });
      }
    }

    return {
      databaseName: path.basename(this.filePath),
      dialect: this.dialect,
      inspectedAt: new Date().toISOString(),
      tables,
      foreignKeys: allForeignKeys
    };
  }

  public async close(): Promise<void> {
    if (this.dbInstance) {
      this.dbInstance.close();
      this.dbInstance = null;
    }
  }
}
