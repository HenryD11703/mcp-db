import type {
  DatabaseAdapter,
  EngineDialect,
  QueryExecutionResult
} from '../../../src/contracts/database-adapter.js';

export type FederatedJoinType = 'LEFT' | 'INNER';
export type FederatedOverflowAction = 'truncate' | 'fail';

export type FederatedOperationStatus =
  | 'INIT'
  | 'VALIDATING_SOURCE'
  | 'GUARD_SOURCE'
  | 'EXECUTING_SOURCE'
  | 'EXTRACTING_KEYS'
  | 'PREPARING_TARGET'
  | 'GUARD_TARGET'
  | 'EXECUTING_TARGET'
  | 'IN_MEMORY_JOIN'
  | 'MASKING'
  | 'COMPLETED'
  | 'EMPTY_SOURCE'
  | 'REJECTED_GUARD'
  | 'BLOCKED_BY_COST'
  | 'KEY_OVERFLOW_REJECTED'
  | 'FAILED';

export interface FederatedQueryOptions {
  readonly sourceAdapterId: string;
  readonly sourceSql: string;
  readonly sourceKeyColumn: string;
  readonly targetAdapterId: string;
  readonly targetSqlTemplate: string;
  readonly targetJoinColumn: string;
  readonly joinType?: FederatedJoinType;
  readonly maxKeys?: number;
  readonly overflowAction?: FederatedOverflowAction;
  readonly requesterId?: string;
  readonly signal?: AbortSignal;
}

export interface FederatedKeyExtractionResult {
  readonly keyColumn: string;
  readonly rawCount: number;
  readonly uniqueKeys: ReadonlyArray<string | number>;
  readonly nullCount: number;
  readonly isTruncated: boolean;
  readonly totalAvailableKeys: number;
}

export interface FederatedColumnDefinition {
  readonly name: string;
  readonly type: string;
  readonly sourceOrigin: 'source' | 'target';
  readonly isMaskedOrPseudonymized: boolean;
}

export interface FederatedQueryResult {
  readonly federationId: string;
  readonly status: 'SUCCESS' | 'EMPTY_SOURCE' | 'TRUNCATED_KEYS';
  readonly joinType: FederatedJoinType;
  readonly totalSourceRows: number;
  readonly totalTargetRows: number;
  readonly totalMergedRows: number;
  readonly keysProcessed: number;
  readonly keysTruncated: boolean;
  readonly totalAvailableKeys: number;
  readonly columns: ReadonlyArray<FederatedColumnDefinition>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly maskedColumns: ReadonlyArray<string>;
  readonly executionTimeMs: number;
  readonly warnings?: ReadonlyArray<string>;
}

export interface ISessionPseudonymContext {
  readonly sessionId: string;
  getPseudonym(rawValue: string | number): string;
  getPseudonymBulk(rawValues: ReadonlyArray<string | number>): Map<string | number, string>;
  clearSession(): void;
}

export interface IFederatedQueryOrchestrator {
  executeFederatedQuery(options: FederatedQueryOptions): Promise<FederatedQueryResult>;
}
