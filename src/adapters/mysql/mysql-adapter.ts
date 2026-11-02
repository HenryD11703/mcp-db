import mysql from 'mysql2/promise';
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
import {
  evaluateMySqlPreflight,
  MYSQL_PREFLIGHT_QUERY,
  type MySqlPreflightRow
} from './mysql-preflight.js';
import { MySqlQueryWatchdog } from './mysql-cancellation.js';

export interface MySqlDriverConnection {
  readonly threadId?: number;
  query(sql: string, values?: ReadonlyArray<unknown>): Promise<[any, any]>;
  release(): void;
}

export interface MySqlDriverPool {
  getConnection(): Promise<MySqlDriverConnection>;
  execute(sql: string, values?: ReadonlyArray<unknown>): Promise<[any, any]>;
  end(): Promise<void>;
}

export interface MySqlAdapterOptions {
  readonly adapterId: string;
  readonly dialect?: 'mysql' | 'mariadb';
  readonly pool?: MySqlDriverPool;
  readonly connectionConfig?: mysql.PoolOptions | string;
}

function parseMySqlExplainJson(raw: unknown, adapterId: string): NormalizedRiskProfile {
  let parsed: any;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new QueryPlanAnalysisError(adapterId, 'Failed to parse MySQL EXPLAIN JSON output');
    }
  } else if (raw && typeof raw === 'object') {
    parsed = raw;
  } else {
    throw new QueryPlanAnalysisError(adapterId, 'Invalid EXPLAIN output structure');
  }

  const queryBlock = parsed.query_block ?? parsed;
  const costInfo = queryBlock?.cost_info;
  const estimatedCost = costInfo?.query_cost ? parseFloat(costInfo.query_cost) : 0;

  let hasFullScan = false;
  let hasUnconditionalJoin = false;
  let estimatedRows = 0;

  function traverseNode(node: any) {
    if (!node || typeof node !== 'object') return;

    if (node.table) {
      const table = node.table;
      if (table.access_type === 'ALL') {
        hasFullScan = true;
      }
      if (table.rows_examined_per_scan) {
        estimatedRows += Number(table.rows_examined_per_scan);
      }
    }

    if (node.nested_loop && Array.isArray(node.nested_loop)) {
      let scansInLoop = 0;
      for (const item of node.nested_loop) {
        if (item?.table?.access_type === 'ALL') {
          scansInLoop++;
        }
        traverseNode(item);
      }
      if (scansInLoop > 1) {
        hasUnconditionalJoin = true;
      }
    }

    if (node.ordering_operation) {
      traverseNode(node.ordering_operation);
    }
    if (node.grouping_operation) {
      traverseNode(node.grouping_operation);
    }
  }

  traverseNode(queryBlock);

  return {
    estimatedCost: Number.isFinite(estimatedCost) ? estimatedCost : 0,
    estimatedRows: Number.isFinite(estimatedRows) ? estimatedRows : 0,
    hasFullScan,
    hasUnconditionalJoin
  };
}

export class MySqlAdapter implements DatabaseAdapter {
  public readonly adapterId: string;
  public readonly dialect: EngineDialect;
  private readonly pool: MySqlDriverPool;
  private readonly validator = new HardenedAstValidator();
  private readonly watchdog: MySqlQueryWatchdog;

  constructor(options: MySqlAdapterOptions) {
    this.adapterId = options.adapterId;
    this.dialect = options.dialect ?? 'mysql';

    if (options.pool) {
      this.pool = options.pool;
    } else if (options.connectionConfig) {
      const pool = mysql.createPool(options.connectionConfig as any);
      this.pool = {
        async getConnection(): Promise<MySqlDriverConnection> {
          const conn = await pool.getConnection();
          return {
            threadId: conn.threadId,
            query: (sql, vals) => conn.query(sql, vals as any),
            release: () => conn.release()
          };
        },
        execute: (sql, vals) => pool.execute(sql, vals as any),
        end: () => pool.end()
      };
    } else {
      throw new Error('Either pool or connectionConfig must be supplied to MySqlAdapter.');
    }

    this.watchdog = new MySqlQueryWatchdog(this.pool);
  }

  private assertValidSelect(sql: string): void {
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

    const conn = await this.pool.getConnection();
    try {
      await conn.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
      const [rows] = await conn.query(MYSQL_PREFLIGHT_QUERY);
      const preflightRow = Array.isArray(rows) && rows.length > 0 ? (rows[0] as MySqlPreflightRow) : undefined;
      return evaluateMySqlPreflight(preflightRow);
    } finally {
      conn.release();
    }
  }

  public async analyzeQueryPlan(query: ParameterizedQuery): Promise<NormalizedRiskProfile> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const conn = await this.pool.getConnection();
    let cleanupWatchdog: (() => void) | undefined;

    try {
      await conn.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
      cleanupWatchdog = this.watchdog.attachCancellation(conn.threadId, query.signal);

      const boundValues = query.params.map((p) => p.value);
      const explainSql = `EXPLAIN FORMAT=JSON ${query.sql}`;
      const [rows] = await conn.query(explainSql, boundValues);

      const firstRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : undefined;
      const explainJson = firstRow ? (firstRow.EXPLAIN ?? firstRow['QUERY PLAN'] ?? firstRow) : undefined;
      return parseMySqlExplainJson(explainJson, this.adapterId);
    } catch (err) {
      if (err instanceof QueryPlanAnalysisError || err instanceof QueryCancelledError) {
        throw err;
      }
      if (query.signal?.aborted) {
        throw new QueryCancelledError(this.adapterId);
      }
      const msg = err instanceof Error ? err.message : 'Unknown planner error';
      throw new QueryPlanAnalysisError(this.adapterId, msg);
    } finally {
      if (cleanupWatchdog) cleanupWatchdog();
      conn.release();
    }
  }

  public async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const conn = await this.pool.getConnection();
    const startedAt = Date.now();
    let cleanupWatchdog: (() => void) | undefined;

    try {
      await conn.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
      cleanupWatchdog = this.watchdog.attachCancellation(conn.threadId, query.signal);

      const boundValues = query.params.map((p) => p.value);
      const executionPromise = conn.query(query.sql, boundValues);

      let res: [any, any];
      if (query.signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          query.signal!.addEventListener(
            'abort',
            () => reject(new QueryCancelledError(this.adapterId)),
            { once: true }
          );
        });
        res = await Promise.race([executionPromise, abortPromise]);
      } else {
        res = await executionPromise;
      }

      const rows = Array.isArray(res[0]) ? res[0] : [];
      const fields = Array.isArray(res[1]) ? res[1] : [];
      return this.formatResult(rows, fields, query.maxRows, Date.now() - startedAt);
    } catch (err) {
      if (query.signal?.aborted || err instanceof QueryCancelledError) {
        throw new QueryCancelledError(this.adapterId);
      }
      throw err;
    } finally {
      if (cleanupWatchdog) cleanupWatchdog();
      conn.release();
    }
  }

  private formatResult(
    rows: any[],
    fields: any[],
    maxRows?: number,
    executionTimeMs = 0
  ): QueryExecutionResult {
    let effectiveRows = rows;

    if (typeof maxRows === 'number' && maxRows > 0 && rows.length > maxRows) {
      effectiveRows = rows.slice(0, maxRows);
    }

    const first = effectiveRows[0];
    const columns: ColumnDescriptor[] = fields.map((f: any) => ({
      name: f.name ?? 'column',
      dataType: typeof f.type === 'number' ? String(f.type) : 'string'
    }));

    if (columns.length === 0 && first && typeof first === 'object') {
      for (const key of Object.keys(first)) {
        columns.push({
          name: key,
          dataType: typeof first[key]
        });
      }
    }

    return {
      columns,
      rows: effectiveRows,
      rowCount: effectiveRows.length,
      durationMs: executionTimeMs
    };
  }

  public async introspectSchema(signal?: AbortSignal): Promise<SchemaCatalog> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const conn = await this.pool.getConnection();
    try {
      const [dbRows] = await conn.query('SELECT DATABASE() AS database_name');
      const dbName =
        Array.isArray(dbRows) && dbRows.length > 0 ? String(dbRows[0].database_name ?? 'mysql') : 'mysql';

      const tablesSql = `
        SELECT
          t.TABLE_SCHEMA AS schema_name,
          t.TABLE_NAME AS table_name,
          CASE WHEN t.TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS table_kind,
          c.COLUMN_NAME AS column_name,
          c.DATA_TYPE AS data_type,
          (c.IS_NULLABLE = 'YES') AS is_nullable,
          c.ORDINAL_POSITION AS ordinal_position,
          (c.COLUMN_KEY = 'PRI') AS is_primary_key
        FROM information_schema.tables t
        INNER JOIN information_schema.columns c
          ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
         AND c.TABLE_NAME = t.TABLE_NAME
        WHERE t.TABLE_SCHEMA = DATABASE()
        ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME, c.ORDINAL_POSITION
      `;
      const [tablesResult] = await conn.query(tablesSql);

      const fksSql = `
        SELECT
          kcu.CONSTRAINT_NAME AS constraint_name,
          kcu.TABLE_SCHEMA AS source_schema,
          kcu.TABLE_NAME AS source_table,
          kcu.COLUMN_NAME AS source_column,
          kcu.REFERENCED_TABLE_SCHEMA AS target_schema,
          kcu.REFERENCED_TABLE_NAME AS target_table,
          kcu.REFERENCED_COLUMN_NAME AS target_column
        FROM information_schema.key_column_usage kcu
        WHERE kcu.TABLE_SCHEMA = DATABASE()
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      `;
      const [fksResult] = await conn.query(fksSql);

      const tableMap = new Map<
        string,
        {
          schema: string;
          name: string;
          kind: 'TABLE' | 'VIEW';
          columns: ColumnMetadata[];
          primaryKeyColumns: string[];
        }
      >();

      const rows = Array.isArray(tablesResult) ? tablesResult : [];
      for (const row of rows) {
        const schema = String(row.schema_name ?? dbName);
        const name = String(row.table_name ?? '');
        const key = `${schema}.${name}`;
        let entry = tableMap.get(key);
        if (!entry) {
          entry = {
            schema,
            name,
            kind: row.table_kind === 'VIEW' ? 'VIEW' : 'TABLE',
            columns: [],
            primaryKeyColumns: []
          };
          tableMap.set(key, entry);
        }

        const colName = String(row.column_name ?? '');
        const isPk = Boolean(row.is_primary_key);
        entry.columns.push({
          name: colName,
          dataType: String(row.data_type ?? 'varchar'),
          isNullable: Boolean(row.is_nullable),
          ordinalPosition: Number(row.ordinal_position ?? entry.columns.length + 1)
        });

        if (isPk && !entry.primaryKeyColumns.includes(colName)) {
          entry.primaryKeyColumns.push(colName);
        }
      }

      const fkRows = Array.isArray(fksResult) ? fksResult : [];
      const fkList: ForeignKeyMetadata[] = fkRows.map((fk: any) => ({
        constraintName: String(fk.constraint_name ?? 'FK'),
        sourceSchema: String(fk.source_schema ?? dbName),
        sourceTable: String(fk.source_table ?? ''),
        sourceColumn: String(fk.source_column ?? ''),
        targetSchema: String(fk.target_schema ?? dbName),
        targetTable: String(fk.target_table ?? ''),
        targetColumn: String(fk.target_column ?? '')
      }));

      const tables: TableMetadata[] = Array.from(tableMap.values()).map((t) => ({
        schema: t.schema,
        name: t.name,
        kind: t.kind,
        columns: t.columns,
        primaryKeyColumns: t.primaryKeyColumns
      }));

      return {
        databaseName: dbName,
        dialect: this.dialect,
        inspectedAt: new Date().toISOString(),
        tables,
        foreignKeys: fkList
      };
    } finally {
      conn.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
