/**
 * Security & Zero-Trust Contracts for db-mcp-node
 * Defines interfaces for the SQL Security Guard, Preflight Startup Gate,
 * In-Memory Data Masking Engine, and Zero-Trust Structural Sanitizer.
 */

import type {
  EngineDialect,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  SqlValidationResult
} from '../../contracts/database-adapter.js';

export type SecurityViolationCode =
  | 'V01_STACKED_QUERIES'
  | 'V02_SELECT_INTO'
  | 'V03_COMMENT_OBFUSCATION'
  | 'V04_MUTATING_CTE'
  | 'V05_FORBIDDEN_FUNCTION'
  | 'V06_MUTATING_DML'
  | 'V07_DDL_COMMAND'
  | 'V08_PROCEDURE_CALL'
  | 'V09_TRANSACTION_CONTROL'
  | 'V10_SESSION_COMMAND'
  | 'SYNTAX_ERROR'
  | 'EMPTY_QUERY';

export interface SecurityViolation {
  readonly allowed: false;
  readonly reasonCode: SecurityViolationCode;
  readonly message: string;
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
  validateQuery(sql: string, dialect: EngineDialect): SqlValidationResult;
}

/**
 * Contract for the Startup Preflight Gate enforcing read-only verification before admitting queries.
 */
export interface IStartupPreflightGate {
  /**
   * Evaluates read-only permissions across all configured database connections.
   * If any connection has write permissions, it logs the violations and halts process execution.
   */
  verifyAndEnforceStartup(signal?: AbortSignal): Promise<ReadonlyMap<string, ReadOnlyVerificationResult>>;
}

export type SensitiveDataType = 'email' | 'phone' | 'dpi' | 'amount' | 'custom';
export type MaskingStrategy = 'partial' | 'redact' | 'mask_amount' | 'custom';

export interface MaskingRule {
  readonly id: string;
  readonly targetType: 'column_name' | 'content_pattern';
  readonly matcher: string | RegExp;
  readonly dataType: SensitiveDataType;
  readonly strategy: MaskingStrategy;
  readonly customMask?: string;
  readonly enabled: boolean;
}

export interface MaskingProfile {
  readonly profileName: string;
  readonly rules: ReadonlyArray<MaskingRule>;
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
