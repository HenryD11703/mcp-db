import pg from 'pg';
import type {
  ColumnDescriptor,
  ColumnMetadata,
  DatabaseAdapter,
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
import { normalizePostgresPlan } from './postgres-plan-parser.js';
import { fetchPostgresCatalogExtras } from './postgres-catalog.js';
import { buildContainmentSql } from '../../core/discovery/containment-sql.js';
import type {
  CatalogCapableAdapter,
  CatalogExtras,
  ColumnRef,
  ContainmentEvidence,
  ContainmentSampleOptions
} from '../../contracts/legacy-discovery.contract.js';

export interface PostgresDriverSession {
  readonly processID?: number;
  query(
    sql: string,
    values?: ReadonlyArray<unknown>
  ): Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
    fields?: ReadonlyArray<{ name: string; dataTypeID?: number }>;
  }>;
  release(): void;
}

export interface PostgresDriverPool {
  connect(): Promise<PostgresDriverSession>;
  cancelBackend(processID: number): Promise<void>;
  end(): Promise<void>;
}

const PG_PRIVILEGE_PREFLIGHT_SQL = `
  SELECT
    current_user AS principal_name,
    current_database() AS database_name,
    r.rolsuper AS is_superuser,
    r.rolcreatedb AS can_createdb,
    r.rolcreaterole AS can_createrole,
    has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_db,
    EXISTS (
      SELECT 1
      FROM information_schema.table_privileges tp
      WHERE tp.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND tp.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
        AND (tp.grantee = current_user OR tp.grantee = 'PUBLIC')
    ) AS has_table_write_grant
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user
`;

const PG_SCHEMA_TABLES_SQL = `
  SELECT
    t.table_schema AS schema_name,
    t.table_name AS table_name,
    CASE WHEN t.table_type = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END AS table_kind,
    c.column_name AS column_name,
    c.data_type AS data_type,
    (c.is_nullable = 'YES') AS is_nullable,
    c.ordinal_position AS ordinal_position,
    -- pg_catalog, not information_schema.table_constraints: the latter hides constraints from
    -- roles that only hold SELECT, which is exactly how this server is meant to connect.
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint con
      INNER JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid
      INNER JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
      INNER JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
      WHERE con.contype = 'p'
        AND n.nspname = t.table_schema
        AND cl.relname = t.table_name
        AND a.attname = c.column_name
    ) AS is_primary_key
  FROM information_schema.tables t
  INNER JOIN information_schema.columns c
    ON c.table_schema = t.table_schema
   AND c.table_name = t.table_name
  WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
  ORDER BY t.table_schema, t.table_name, c.ordinal_position
`;

const PG_SCHEMA_FKS_SQL = `
  SELECT
    con.conname AS constraint_name,
    ns.nspname AS source_schema,
    cl.relname AS source_table,
    sa.attname AS source_column,
    tns.nspname AS target_schema,
    tcl.relname AS target_table,
    ta.attname AS target_column
  FROM pg_catalog.pg_constraint con
  INNER JOIN pg_catalog.pg_class cl ON cl.oid = con.conrelid
  INNER JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace
  INNER JOIN pg_catalog.pg_class tcl ON tcl.oid = con.confrelid
  INNER JOIN pg_catalog.pg_namespace tns ON tns.oid = tcl.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(src, tgt, ord)
  INNER JOIN pg_catalog.pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = k.src
  INNER JOIN pg_catalog.pg_attribute ta ON ta.attrelid = con.confrelid AND ta.attnum = k.tgt
  WHERE con.contype = 'f'
    AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY con.conname, k.ord
`;

const PG_TYPE_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(pg.types.builtins).map(([name, oid]) => [Number(oid), name.toLowerCase()])
);

/** Readable name for a result-set type OID (`1043` -> `varchar`); custom types keep `oid:<n>`. */
export function pgTypeName(oid: number): string {
  return PG_TYPE_NAMES.get(oid) ?? `oid:${oid}`;
}

export function createNodePostgresDriverPool(config: pg.PoolConfig): PostgresDriverPool {
  const pool = new pg.Pool(config);
  return {
    async connect(): Promise<PostgresDriverSession> {
      const client = await pool.connect();
      const pid = (client as unknown as { processID?: number }).processID;
      return {
        processID: pid,
        async query(sql: string, values?: ReadonlyArray<unknown>) {
          const res = await client.query(sql, values ? [...values] : undefined);
          return {
            rows: res.rows as ReadonlyArray<Record<string, unknown>>,
            fields: res.fields
          };
        },
        release() {
          client.release();
        }
      };
    },
    async cancelBackend(processID: number): Promise<void> {
      await pool.query('SELECT pg_cancel_backend($1)', [processID]);
    },
    async end(): Promise<void> {
      await pool.end();
    }
  };
}

function isPostgresDriverPool(
  value: PostgresDriverPool | pg.PoolConfig
): value is PostgresDriverPool {
  return (
    typeof (value as PostgresDriverPool).connect === 'function' &&
    typeof (value as PostgresDriverPool).cancelBackend === 'function' &&
    typeof (value as PostgresDriverPool).end === 'function'
  );
}

export class PostgresAdapter implements DatabaseAdapter, CatalogCapableAdapter {
  public readonly dialect = 'postgres' as const;
  public readonly adapterId: string;
  private readonly pool: PostgresDriverPool;
  private readonly validator = new HardenedAstValidator();

  constructor(adapterId: string, poolOrConfig: PostgresDriverPool | pg.PoolConfig) {
    this.adapterId = adapterId;
    if (isPostgresDriverPool(poolOrConfig)) {
      this.pool = poolOrConfig;
    } else {
      this.pool = createNodePostgresDriverPool(poolOrConfig);
    }
  }

  public async verifyReadOnly(signal?: AbortSignal): Promise<ReadOnlyVerificationResult> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const session = await this.pool.connect();
    try {
      await session.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      const res = await session.query(PG_PRIVILEGE_PREFLIGHT_SQL);
      const row = res.rows[0] ?? {};

      const principalName = String(row['principal_name'] ?? 'unknown');
      const violations: string[] = [];

      if (row['is_superuser'] === true) {
        violations.push(`Role "${principalName}" has SUPERUSER privilege.`);
      }
      if (row['can_createdb'] === true) {
        violations.push(`Role "${principalName}" has CREATEDB privilege.`);
      }
      if (row['can_createrole'] === true) {
        violations.push(`Role "${principalName}" has CREATEROLE privilege.`);
      }
      if (row['can_create_in_db'] === true) {
        violations.push(`Role "${principalName}" has CREATE privilege on database.`);
      }
      if (row['has_table_write_grant'] === true) {
        violations.push(
          `Role "${principalName}" (or PUBLIC) holds effective write privileges (INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER) on user tables.`
        );
      }

      return {
        isReadOnly: violations.length === 0,
        principalName,
        sessionReadOnlyEnforced: true,
        violations,
        checkedAt: new Date().toISOString()
      };
    } finally {
      session.release();
    }
  }

  public async analyzeQueryPlan(query: ParameterizedQuery): Promise<NormalizedRiskProfile> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const session = await this.pool.connect();
    try {
      const boundValues = query.params.map((p) => p.value);
      const explainSql = `EXPLAIN (FORMAT JSON) ${query.sql}`;
      const res = await session.query(explainSql, boundValues);
      const firstRow = res.rows[0];
      const rawPlan = firstRow ? firstRow['QUERY PLAN'] ?? firstRow : undefined;
      return normalizePostgresPlan(rawPlan, this.adapterId);
    } catch (err) {
      if (err instanceof QueryPlanAnalysisError || err instanceof QueryCancelledError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Unknown planner error';
      throw new QueryPlanAnalysisError(this.adapterId, msg);
    } finally {
      session.release();
    }
  }

  public async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
    this.assertValidSelect(query.sql);

    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const session = await this.pool.connect();
    const startedAt = Date.now();
    let onAbort: (() => void) | undefined;

    try {
      const boundValues = query.params.map((p) => p.value);

      const executionPromise = session.query(query.sql, boundValues);

      if (query.signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          onAbort = () => {
            const pid = session.processID;
            const cancelDone =
              typeof pid === 'number'
                ? this.pool.cancelBackend(pid).catch(() => undefined)
                : Promise.resolve();
            void cancelDone.finally(() => {
              reject(new QueryCancelledError(this.adapterId));
            });
          };
          query.signal!.addEventListener('abort', onAbort, { once: true });
        });

        const res = await Promise.race([executionPromise, abortPromise]);
        return this.formatResult(res, query.maxRows, Date.now() - startedAt);
      }

      const res = await executionPromise;
      return this.formatResult(res, query.maxRows, Date.now() - startedAt);
    } finally {
      if (query.signal && onAbort) {
        query.signal.removeEventListener('abort', onAbort);
      }
      session.release();
    }
  }

  public async introspectSchema(signal?: AbortSignal): Promise<SchemaCatalog> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    const session = await this.pool.connect();
    try {
      const dbNameRes = await session.query('SELECT current_database() AS database_name');
      const databaseName = String(dbNameRes.rows[0]?.['database_name'] ?? 'postgres');

      const tablesRes = await session.query(PG_SCHEMA_TABLES_SQL);
      const fksRes = await session.query(PG_SCHEMA_FKS_SQL);

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

      for (const row of tablesRes.rows) {
        const schema = String(row['schema_name'] ?? 'public');
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

        if (row['is_primary_key'] === true && !entry.primaryKeyColumns.includes(colName)) {
          entry.primaryKeyColumns.push(colName);
        }
      }

      const tables: TableMetadata[] = Array.from(tableMap.values());
      const foreignKeys: ForeignKeyMetadata[] = fksRes.rows.map((fk) => ({
        constraintName: String(fk['constraint_name'] ?? ''),
        sourceSchema: String(fk['source_schema'] ?? 'public'),
        sourceTable: String(fk['source_table'] ?? ''),
        sourceColumn: String(fk['source_column'] ?? ''),
        targetSchema: String(fk['target_schema'] ?? 'public'),
        targetTable: String(fk['target_table'] ?? ''),
        targetColumn: String(fk['target_column'] ?? '')
      }));

      return {
        databaseName,
        dialect: 'postgres',
        tables,
        foreignKeys,
        inspectedAt: new Date().toISOString()
      };
    } finally {
      session.release();
    }
  }

  public async getCatalogExtras(signal?: AbortSignal): Promise<CatalogExtras> {
    if (signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }
    const session = await this.pool.connect();
    try {
      return await fetchPostgresCatalogExtras(session);
    } finally {
      session.release();
    }
  }

  /**
   * Bounded containment probe executed through `executeQuery`, so it passes the
   * read-only AST guard and uses native cancellation. Only two counters are returned.
   */
  public async sampleContainment(
    child: ColumnRef,
    parent: ColumnRef,
    options: ContainmentSampleOptions
  ): Promise<ContainmentEvidence> {
    const sql = buildContainmentSql('postgres', child, parent, options.maxSample);
    const result = await this.executeQuery({
      sql,
      params: [],
      maxRows: 1,
      ...(options.signal ? { signal: options.signal } : {})
    });
    const row = result.rows[0] ?? {};
    return { sampled: Number(row['sampled'] ?? 0), matched: Number(row['matched'] ?? 0) };
  }

  public async close(): Promise<void> {    await this.pool.end();
  }

  private assertValidSelect(sql: string): void {
    const check = this.validator.validateSelectOnly(sql, 'postgres');
    if (!check.allowed) {
      throw new SqlSecurityRejectionError(
        check.reasonCode ?? 'NON_SELECT_ROOT',
        'postgres',
        check.message
      );
    }
  }

  private formatResult(
    res: {
      rows: ReadonlyArray<Record<string, unknown>>;
      fields?: ReadonlyArray<{ name: string; dataTypeID?: number }>;
    },
    maxRows: number | undefined,
    durationMs: number
  ): QueryExecutionResult {
    const slicedRows =
      typeof maxRows === 'number' && maxRows > 0 ? res.rows.slice(0, maxRows) : res.rows;
    const columns: ColumnDescriptor[] =
      res.fields && res.fields.length > 0
        ? res.fields.map((f) => ({
            name: f.name,
            dataType: f.dataTypeID !== undefined ? pgTypeName(f.dataTypeID) : 'unknown'
          }))
        : Object.keys(slicedRows[0] ?? {}).map((k) => ({ name: k, dataType: 'unknown' }));

    return {
      columns,
      rows: slicedRows,
      rowCount: slicedRows.length,
      durationMs: Math.max(0, durationMs)
    };
  }
}
