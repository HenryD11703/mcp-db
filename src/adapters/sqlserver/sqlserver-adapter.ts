import sql from 'mssql';
import type {
  ColumnDescriptor,
  ColumnMetadata,
  DatabaseAdapter,
  ForeignKeyMetadata,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  QueryParameter,
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
import { normalizeSqlServerPlanXml } from './sqlserver-plan-parser.js';

export interface SqlServerDriverRequest {
  input(name: string, type: QueryParameter['type'], value: unknown): void;
  query(command: string): Promise<{
    recordset: ReadonlyArray<Record<string, unknown>>;
  }>;
  cancel(): void;
}

export interface SqlServerDriverPool {
  createRequest(): SqlServerDriverRequest;
  explainXml(sqlText: string, params: ReadonlyArray<QueryParameter>): Promise<string>;
  close(): Promise<void>;
}

const TSQL_PRIVILEGE_PREFLIGHT_SQL = `
  SELECT
    USER_NAME() AS principal_name,
    DB_NAME() AS database_name,
    ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0) AS is_sysadmin,
    ISNULL(IS_ROLEMEMBER('db_owner'), 0) AS is_db_owner,
    ISNULL(IS_ROLEMEMBER('db_datawriter'), 0) AS is_db_datawriter,
    ISNULL(IS_ROLEMEMBER('db_ddladmin'), 0) AS is_db_ddladmin,
    (
      SELECT COUNT(1)
      FROM sys.fn_my_permissions(NULL, 'DATABASE')
      WHERE permission_name IN (
        'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL',
        'CREATE TABLE', 'CREATE PROCEDURE', 'CREATE FUNCTION', 'EXECUTE'
      )
    ) AS write_permission_count
`;

const TSQL_SCHEMA_TABLES_SQL = `
  SELECT
    s.name AS schema_name,
    o.name AS table_name,
    CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'TABLE' END AS table_kind,
    c.name AS column_name,
    t.name AS data_type,
    c.is_nullable AS is_nullable,
    c.column_id AS ordinal_position,
    CAST(
      CASE WHEN EXISTS (
        SELECT 1
        FROM sys.indexes i
        INNER JOIN sys.index_columns ic
          ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1
          AND i.object_id = o.object_id
          AND ic.column_id = c.column_id
      ) THEN 1 ELSE 0 END AS bit
    ) AS is_primary_key
  FROM sys.objects o
  INNER JOIN sys.schemas s ON o.schema_id = s.schema_id
  INNER JOIN sys.columns c ON o.object_id = c.object_id
  INNER JOIN sys.types t ON c.user_type_id = t.user_type_id
  WHERE o.type IN ('U', 'V')
    AND o.is_ms_shipped = 0
  ORDER BY s.name, o.name, c.column_id
`;

const TSQL_SCHEMA_FKS_SQL = `
  SELECT
    fk.name AS constraint_name,
    ss.name AS source_schema,
    so.name AS source_table,
    sc.name AS source_column,
    ts.name AS target_schema,
    tobj.name AS target_table,
    tc.name AS target_column
  FROM sys.foreign_keys fk
  INNER JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
  INNER JOIN sys.objects so ON fkc.parent_object_id = so.object_id
  INNER JOIN sys.schemas ss ON so.schema_id = ss.schema_id
  INNER JOIN sys.columns sc ON fkc.parent_object_id = sc.object_id AND fkc.parent_column_id = sc.column_id
  INNER JOIN sys.objects tobj ON fkc.referenced_object_id = tobj.object_id
  INNER JOIN sys.schemas ts ON tobj.schema_id = ts.schema_id
  INNER JOIN sys.columns tc ON fkc.referenced_object_id = tc.object_id AND fkc.referenced_column_id = tc.column_id
  ORDER BY fk.name
`;

function bindMssqlParameter(
  req: sql.Request,
  name: string,
  paramType: QueryParameter['type'],
  value: unknown
): void {
  switch (paramType) {
    case 'number':
      req.input(name, typeof value === 'number' && Number.isInteger(value) ? sql.Int : sql.Float, value);
      break;
    case 'boolean':
      req.input(name, sql.Bit, value);
      break;
    case 'date':
      req.input(name, sql.DateTime2, value);
      break;
    case 'null':
      req.input(name, sql.NVarChar, null);
      break;
    case 'string':
    default:
      req.input(name, sql.NVarChar, value);
      break;
  }
}

export async function createMssqlDriverPool(config: sql.config): Promise<SqlServerDriverPool> {
  const pool = await new sql.ConnectionPool(config).connect();
  return {
    createRequest(): SqlServerDriverRequest {
      const req = new sql.Request(pool);
      return {
        input(name, type, value) {
          bindMssqlParameter(req, name, type, value);
        },
        async query(command: string) {
          const res = await req.query(command);
          return {
            recordset: (res.recordset ?? []) as ReadonlyArray<Record<string, unknown>>
          };
        },
        cancel() {
          req.cancel();
        }
      };
    },
    async explainXml(sqlText: string, params: ReadonlyArray<QueryParameter>): Promise<string> {
      const req = new sql.Request(pool);
      for (const p of params) {
        bindMssqlParameter(req, p.name, p.type, p.value);
      }
      await req.batch('SET SHOWPLAN_XML ON');
      try {
        const res = await req.query(sqlText);
        const firstRow = res.recordset?.[0] as Record<string, unknown> | undefined;
        const firstValue = firstRow ? Object.values(firstRow)[0] : '';
        return String(firstValue ?? '');
      } finally {
        await req.batch('SET SHOWPLAN_XML OFF').catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      await pool.close();
    }
  };
}

export class SqlServerAdapter implements DatabaseAdapter {
  public readonly dialect = 'tsql' as const;
  public readonly adapterId: string;
  private readonly pool: SqlServerDriverPool;
  private readonly validator = new HardenedAstValidator();

  constructor(adapterId: string, pool: SqlServerDriverPool) {
    this.adapterId = adapterId;
    this.pool = pool;
  }

  public async verifyReadOnly(signal?: AbortSignal): Promise<ReadOnlyVerificationResult> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const req = this.pool.createRequest();
    const res = await req.query(TSQL_PRIVILEGE_PREFLIGHT_SQL);
    const row = res.recordset[0] ?? {};

    const principalName = String(row['principal_name'] ?? 'unknown');
    const violations: string[] = [];

    if (Number(row['is_sysadmin'] ?? 0) === 1) {
      violations.push(`Login "${principalName}" is a member of fixed server role "sysadmin".`);
    }
    if (Number(row['is_db_owner'] ?? 0) === 1) {
      violations.push(`User "${principalName}" is a member of fixed database role "db_owner".`);
    }
    if (Number(row['is_db_datawriter'] ?? 0) === 1) {
      violations.push(`User "${principalName}" is a member of fixed database role "db_datawriter".`);
    }
    if (Number(row['is_db_ddladmin'] ?? 0) === 1) {
      violations.push(`User "${principalName}" is a member of fixed database role "db_ddladmin".`);
    }
    if (Number(row['write_permission_count'] ?? 0) > 0) {
      violations.push(
        `User "${principalName}" holds ${Number(row['write_permission_count'])} effective write/DDL/execute permission(s) in sys.fn_my_permissions.`
      );
    }

    return {
      isReadOnly: violations.length === 0,
      principalName,
      sessionReadOnlyEnforced: violations.length === 0,
      violations,
      checkedAt: new Date().toISOString()
    };
  }

  public async analyzeQueryPlan(query: ParameterizedQuery): Promise<NormalizedRiskProfile> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    try {
      const xml = await this.pool.explainXml(query.sql, query.params);
      return normalizeSqlServerPlanXml(xml, this.adapterId);
    } catch (err) {
      if (err instanceof QueryPlanAnalysisError || err instanceof QueryCancelledError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Unknown SHOWPLAN_XML error';
      throw new QueryPlanAnalysisError(this.adapterId, msg);
    }
  }

  public async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const req = this.pool.createRequest();
    for (const param of query.params) {
      req.input(param.name, param.type, param.value);
    }

    const startedAt = Date.now();
    let onAbort: (() => void) | undefined;

    try {
      const executionPromise = req.query(query.sql);

      if (query.signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => {
            req.cancel();
            reject(new QueryCancelledError(this.adapterId));
          };
          query.signal!.addEventListener('abort', onAbort, { once: true });
        });

        const res = await Promise.race([executionPromise, abortPromise]);
        return this.formatResult(res.recordset, query.maxRows, Date.now() - startedAt);
      }

      const res = await executionPromise;
      return this.formatResult(res.recordset, query.maxRows, Date.now() - startedAt);
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

    const dbReq = this.pool.createRequest();
    const dbRes = await dbReq.query('SELECT DB_NAME() AS database_name');
    const databaseName = String(dbRes.recordset[0]?.['database_name'] ?? 'master');

    const tablesReq = this.pool.createRequest();
    const tablesRes = await tablesReq.query(TSQL_SCHEMA_TABLES_SQL);

    const fksReq = this.pool.createRequest();
    const fksRes = await fksReq.query(TSQL_SCHEMA_FKS_SQL);

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

    for (const row of tablesRes.recordset) {
      const schema = String(row['schema_name'] ?? 'dbo');
      const name = String(row['table_name'] ?? '');
      const key = `${schema}.${name}`;
      let entry = tableMap.get(key);
      if (!entry) {
        entry = {
          schema,
          name,
          kind: row['table_kind'] === 'VIEW' ? 'VIEW' : 'TABLE',
          columns: [],
          primaryKeyColumns: []
        };
        tableMap.set(key, entry);
      }

      const colName = String(row['column_name'] ?? '');
      entry.columns.push({
        name: colName,
        dataType: String(row['data_type'] ?? 'unknown'),
        isNullable: Boolean(row['is_nullable']),
        ordinalPosition: Number(row['ordinal_position'] ?? entry.columns.length + 1)
      });

      if (Boolean(row['is_primary_key']) && !entry.primaryKeyColumns.includes(colName)) {
        entry.primaryKeyColumns.push(colName);
      }
    }

    const tables: TableMetadata[] = Array.from(tableMap.values());
    const foreignKeys: ForeignKeyMetadata[] = fksRes.recordset.map((fk) => ({
      constraintName: String(fk['constraint_name'] ?? ''),
      sourceSchema: String(fk['source_schema'] ?? 'dbo'),
      sourceTable: String(fk['source_table'] ?? ''),
      sourceColumn: String(fk['source_column'] ?? ''),
      targetSchema: String(fk['target_schema'] ?? 'dbo'),
      targetTable: String(fk['target_table'] ?? ''),
      targetColumn: String(fk['target_column'] ?? '')
    }));

    return {
      databaseName,
      dialect: 'tsql',
      tables,
      foreignKeys,
      inspectedAt: new Date().toISOString()
    };
  }

  public async close(): Promise<void> {
    await this.pool.close();
  }

  private assertValidSelect(sqlText: string): void {
    const check = this.validator.validateSelectOnly(sqlText, 'tsql');
    if (!check.allowed) {
      throw new SqlSecurityRejectionError(
        check.reasonCode ?? 'NON_SELECT_ROOT',
        'tsql',
        check.message
      );
    }
  }

  private formatResult(
    rows: ReadonlyArray<Record<string, unknown>>,
    maxRows: number | undefined,
    durationMs: number
  ): QueryExecutionResult {
    const slicedRows =
      typeof maxRows === 'number' && maxRows > 0 ? rows.slice(0, maxRows) : rows;
    const columns: ColumnDescriptor[] = Object.keys(slicedRows[0] ?? {}).map((name) => ({
      name,
      dataType: 'sql_variant'
    }));

    return {
      columns,
      rows: slicedRows,
      rowCount: slicedRows.length,
      durationMs: Math.max(0, durationMs)
    };
  }
}
