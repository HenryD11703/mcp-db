import type {
  EngineDialect,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  RejectionReasonCode,
  SqlValidationResult
} from './database-adapter.js';

export type SecurityViolationCode =
  | RejectionReasonCode
  | 'V01_STACKED_QUERIES'
  | 'V02_SELECT_INTO'
  | 'V03_COMMENT_OBFUSCATION'
  | 'V04_MUTATING_CTE'
  | 'V05_FORBIDDEN_FUNCTION'
  | 'V05_DANGEROUS_FUNCTIONS'
  | 'V06_MUTATING_DML'
  | 'V06_EXPLICIT_LOCKING'
  | 'V07_DDL_COMMAND'
  | 'V07_REMOTE_LINKED_ACCESS'
  | 'V08_PROCEDURE_CALL'
  | 'V08_TSQL_IMPLICIT_EXEC'
  | 'V09_TRANSACTION_CONTROL'
  | 'V09_DELAY_DOS'
  | 'V10_SESSION_COMMAND'
  | 'V10_SESSION_OR_INTERNAL_CMD'
  | 'NON_SELECT_ROOT'
  | 'SYNTAX_ERROR'
  | 'EMPTY_QUERY';

export interface SecurityViolation {
  readonly allowed: false;
  readonly reasonCode: SecurityViolationCode;
  readonly message: string;
  readonly nodeType?: string;
  readonly detectedInStage?: 'lexical' | 'ast';
}

export interface ExtendedSqlValidationResult extends Omit<SqlValidationResult, 'reasonCode'> {
  readonly allowed: boolean;
  readonly reasonCode?: SecurityViolationCode;
  readonly message?: string;
  readonly nodeType?: string;
  readonly detectedInStage?: 'lexical' | 'ast';
}

/**
 * Contract for the SQL Security Guard validating incoming queries before database execution.
 */
export interface ISqlSecurityGuard {
  /**
   * Validates that the query is strictly a single, read-only SELECT statement
   * without comments, stacked queries, mutating CTEs, SELECT INTO, or procedure calls.
   */
  validateQuery(sql: string, dialect: EngineDialect): ExtendedSqlValidationResult;
}

export interface PreflightAdapterReport {
  readonly adapterId: string;
  readonly dialect: EngineDialect;
  readonly principalName: string;
  readonly isReadOnly: boolean;
  readonly violations: ReadonlyArray<string>;
  readonly checkedAt: string;
}

export interface ServerPreflightSummary {
  readonly allPassed: boolean;
  readonly totalAdapters: number;
  readonly reports: ReadonlyArray<PreflightAdapterReport>;
  readonly abortedProcess: boolean;
}

/**
 * Contract for the Startup Preflight Gate enforcing read-only verification before admitting queries.
 */
export interface IStartupPreflightGate {
  /**
   * Evaluates read-only permissions across all configured database connections.
   * If any connection has write permissions, it logs the violations and halts process execution.
   */
  verifyAndEnforceStartup(
    signal?: AbortSignal
  ): Promise<ReadonlyMap<string, ReadOnlyVerificationResult>>;
}

export type SensitiveDataType = 'email' | 'phone' | 'dpi' | 'amount' | 'nit' | 'custom';
export type MaskingStrategy = 'partial' | 'redact' | 'session_pseudonym' | 'mask_amount' | 'custom';

export type ConfidenceState = 'deterministic' | 'low_confidence_fail_safe' | 'none';

export interface UnifiedPrefixConfig {
  readonly organizationalPrefixes: ReadonlyArray<string>;
  readonly technicalPrefixes: ReadonlyArray<string>;
  readonly abbreviationPrefixes: ReadonlyArray<string>;
  readonly customPrefixes: ReadonlyArray<string>;
}

export interface ColumnClassificationResult {
  readonly columnName: string;
  readonly isSensitive: boolean;
  readonly dataType: SensitiveDataType;
  readonly confidence: ConfidenceState;
  readonly strategy: MaskingStrategy;
  readonly matchedRuleId?: string;
  readonly inferredPrefixes?: ReadonlyArray<string>;
}

export interface MaskingRule {
  readonly id: string;
  readonly targetType: 'column_name' | 'content_pattern';
  readonly matcher: string | RegExp;
  readonly dataType: SensitiveDataType;
  readonly strategy: MaskingStrategy;
  readonly customMask?: string;
  readonly customTransformer?: (rawValue: string) => string;
  readonly enabled: boolean;
}

export interface MaskingProfile {
  readonly profileName: string;
  readonly description?: string;
  readonly rules: ReadonlyArray<MaskingRule>;
  readonly maskUnmatchedAmounts?: boolean;
}

export interface MaskedDataset {
  readonly columns: ReadonlyArray<{ name: string; dataType: string }>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
  readonly maskedCellsCount: number;
  readonly durationMs: number;
}

/**
 * Contract for the In-Memory Data Masking Engine.
 */
export interface IDataMaskingEngine {
  /**
   * Masks sensitive PII and financial data in-memory before serialization.
   * Raw values never leave the process.
   */
  maskDataset(result: QueryExecutionResult, profile?: MaskingProfile): MaskedDataset;
}

export type DelimitedOutputFormat = 'semantic_xml' | 'strict_json';

export interface ZeroTrustEncapsulationOptions {
  readonly format?: DelimitedOutputFormat;
  readonly queryId?: string;
  readonly sanitizeDirectives?: boolean;
  readonly escapeControlChars?: boolean;
}

export interface EncapsulatedDataOutput {
  readonly format: DelimitedOutputFormat;
  readonly formattedText: string;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly containsNeutralizedDirectives: boolean;
}

/**
 * Contract for the Zero-Trust Data Sanitizer.
 */
export interface IZeroTrustSanitizer {
  /**
   * Encapsulates a masked dataset within structural delimiters, neutralizing control characters
   * and potential prompt injection payloads so that LLMs interpret them strictly as literal data.
   */
  encapsulateDataset(
    dataset: MaskedDataset,
    options?: ZeroTrustEncapsulationOptions
  ): EncapsulatedDataOutput;
}
