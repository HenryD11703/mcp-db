import type { EngineDialect } from './database-adapter.js';

export type DatabaseEngineType = EngineDialect | 'mssql' | 'postgres' | string;

export type AuditQueryOutcome =
  | 'EXECUTED'
  | 'REJECTED_BY_GUARD'
  | 'BLOCKED_BY_COST'
  | 'PENDING_APPROVAL'
  | 'CANCELLED_BY_TIMEOUT'
  | 'CATALOG_DISCOVERY'
  | 'RELATIONSHIP_INFERENCE'
  | 'GLOSSARY_QUERY'
  | 'FEDERATED_QUERY_INIT'
  | 'FEDERATED_STEP_SOURCE'
  | 'FEDERATED_KEYS_EXTRACTED'
  | 'FEDERATED_STEP_TARGET'
  | 'FEDERATED_QUERY_COMPLETE'
  | 'FEDERATED_QUERY_FAILED';

export interface AuditLogEntry {
  readonly sequenceNumber: number;
  readonly correlationId: string;
  readonly requesterId: string;
  readonly timestamp: string;
  readonly engine: DatabaseEngineType;
  readonly database: string;
  readonly evaluatedSql: string;
  readonly status: AuditQueryOutcome;
  readonly rejectionReason: string | null;
  readonly executionTimeMs: number;
  readonly rowCount: number;
  readonly previousHash: string;
  readonly entryHash: string;
}

export interface CanonicalAuditPayload {
  readonly correlationId: string;
  readonly database: string;
  readonly engine: string;
  readonly evaluatedSql: string;
  readonly executionTimeMs: number;
  readonly rejectionReason: string | null;
  readonly requesterId: string;
  readonly rowCount: number;
  readonly sequenceNumber: number;
  readonly status: AuditQueryOutcome;
  readonly timestamp: string;
}

export interface AuditVerificationViolation {
  readonly sequenceNumber: number;
  readonly correlationId: string;
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly reason:
    | 'HASH_MISMATCH'
    | 'SEQUENCE_GAP'
    | 'INVALID_JSON'
    | 'PREVIOUS_HASH_MISMATCH';
  readonly lineNumber: number;
  readonly rawLine?: string;
}

export interface AuditVerificationResult {
  readonly isValid: boolean;
  readonly totalEntries: number;
  readonly firstSequenceNumber: number;
  readonly lastSequenceNumber: number;
  readonly violatedEntry?: AuditVerificationViolation;
}

export interface ISqlSanitizerForAudit {
  sanitizeSqlForAudit(rawSql: string): string;
}

export interface IAuditLogger {
  logEvent(
    event: Omit<AuditLogEntry, 'sequenceNumber' | 'previousHash' | 'entryHash'>
  ): Promise<AuditLogEntry>;
  getCurrentSequenceNumber(): number;
  getLatestHash(): string;
  close(): Promise<void>;
}

export interface IAuditVerifier {
  verifyLogFile(filePath: string): Promise<AuditVerificationResult>;
}

export interface AuditLoggerOptions {
  readonly logFilePath: string;
  readonly maxFileSizeBytes?: number;
  readonly rotateDaily?: boolean;
  readonly failClosed?: boolean;
}
