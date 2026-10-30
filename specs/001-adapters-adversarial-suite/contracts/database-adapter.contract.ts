/**
 * Contract: DatabaseAdapter & Adversarial SQL Validator
 * Feature: 001-adapters-adversarial-suite
 * Mode: TypeScript Strict (strict: true)
 */

export type EngineDialect = 'tsql' | 'postgres';
export type CorpusDialect = EngineDialect | 'common';

export type AttackVectorId =
  | 'V01_STACKED_QUERIES'
  | 'V02_SELECT_INTO'
  | 'V03_COMMENT_OBFUSCATION'
  | 'V04_MUTATING_CTE'
  | 'V05_DANGEROUS_FUNCTIONS'
  | 'V06_EXPLICIT_LOCKING'
  | 'V07_REMOTE_LINKED_ACCESS'
  | 'V08_TSQL_IMPLICIT_EXEC'
  | 'V09_DELAY_DOS'
  | 'V10_SESSION_OR_INTERNAL_CMD';

export type RejectionReasonCode =
  | AttackVectorId
  | 'NON_SELECT_ROOT'
  | 'SYNTAX_ERROR'
  | 'EMPTY_QUERY';

export interface ReadOnlyVerificationResult {
  readonly isReadOnly: boolean;
  readonly principalName: string;
  readonly sessionReadOnlyEnforced: boolean;
  readonly violations: ReadonlyArray<string>;
  readonly checkedAt: string;
}

export interface NormalizedRiskProfile {
  readonly hasFullScan: boolean;
  readonly hasUnconditionalJoin: boolean;
  readonly estimatedRows: number;
  readonly estimatedCost: number;
  readonly rawPlanSummary?: string;
}

export type QueryParameterType = 'string' | 'number' | 'boolean' | 'date' | 'null';

export interface QueryParameter {
  readonly name: string;
  readonly type: QueryParameterType;
  readonly value: string | number | boolean | Date | null;
}

export interface ParameterizedQuery {
  readonly sql: string;
  readonly params: ReadonlyArray<QueryParameter>;
  readonly signal?: AbortSignal;
  readonly maxRows?: number;
}

export interface ColumnDescriptor {
  readonly name: string;
  readonly dataType: string;
}

export interface QueryExecutionResult {
  readonly columns: ReadonlyArray<ColumnDescriptor>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
  readonly durationMs: number;
}

export interface ColumnMetadata {
  readonly name: string;
  readonly dataType: string;
  readonly isNullable: boolean;
  readonly ordinalPosition: number;
}

export interface TableMetadata {
  readonly schema: string;
  readonly name: string;
  readonly kind: 'TABLE' | 'VIEW';
  readonly columns: ReadonlyArray<ColumnMetadata>;
  readonly primaryKeyColumns: ReadonlyArray<string>;
}

export interface ForeignKeyMetadata {
  readonly constraintName: string;
  readonly sourceSchema: string;
  readonly sourceTable: string;
  readonly sourceColumn: string;
  readonly targetSchema: string;
  readonly targetTable: string;
  readonly targetColumn: string;
}

export interface SchemaCatalog {
  readonly databaseName: string;
  readonly dialect: EngineDialect;
  readonly tables: ReadonlyArray<TableMetadata>;
  readonly foreignKeys: ReadonlyArray<ForeignKeyMetadata>;
  readonly inspectedAt: string;
}

/**
 * Core contract that every relational database engine adapter MUST implement.
 * The MCP core interacts exclusively with this interface (Principle VII).
 */
export interface DatabaseAdapter {
  readonly dialect: EngineDialect;
  readonly adapterId: string;

  /**
   * 1. Read-only privilege verification (preflight check) - FR-003
   * Inspects effective catalog permissions (including role inheritance and public/guest grants)
   * and enforces read-only session characteristics where supported.
   */
  verifyReadOnly(signal?: AbortSignal): Promise<ReadOnlyVerificationResult>;

  /**
   * 2. Execution plan analysis normalized to a common risk profile - FR-004, FR-005
   * Obtains the optimizer plan without executing the data query.
   */
  analyzeQueryPlan(query: ParameterizedQuery): Promise<NormalizedRiskProfile>;

  /**
   * 3. Parameterized query execution with native engine cancellation via AbortSignal - FR-006
   * Cancels the query inside the database server (<1s) when query.signal is aborted.
   */
  executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult>;

  /**
   * 4. Schema introspection without reading user table rows - FR-007
   */
  introspectSchema(signal?: AbortSignal): Promise<SchemaCatalog>;

  /**
   * Releases underlying connection pools cleanly.
   */
  close(): Promise<void>;
}

export interface SqlValidationResult {
  readonly allowed: boolean;
  readonly reasonCode?: RejectionReasonCode;
  readonly message?: string;
}

/**
 * Contract for evaluating candidate SQL parsers against the adversarial corpus - FR-013
 */
export interface SqlParserCandidate {
  readonly candidateName: string;
  validateSelectOnly(sql: string, dialect: EngineDialect): SqlValidationResult;
}
