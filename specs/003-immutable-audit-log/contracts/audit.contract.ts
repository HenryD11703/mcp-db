import type { DatabaseEngineType } from './database-adapter.js';

export type AuditQueryOutcome =
  | 'EXECUTED'
  | 'REJECTED_BY_GUARD'
  | 'BLOCKED_BY_COST'
  | 'PENDING_APPROVAL'
  | 'CANCELLED_BY_TIMEOUT';

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
  /**
   * Sanitizes all string and numeric literals from the given SQL statement,
   * replacing them with placeholders (? or [REDACTED_LITERAL]/[REDACTED_NUM]),
   * and enforces safe length limits (16 KB).
   */
  sanitizeSqlForAudit(rawSql: string): string;
}

export interface IAuditLogger {
  /**
   * Records a query audit event immutably.
   * Throws AuditPersistenceError in fail-closed mode if writing fails.
   */
  logEvent(
    event: Omit<AuditLogEntry, 'sequenceNumber' | 'previousHash' | 'entryHash'>
  ): Promise<AuditLogEntry>;

  /**
   * Returns the current sequence number.
   */
  getCurrentSequenceNumber(): number;

  /**
   * Returns the hash of the latest entry written.
   */
  getLatestHash(): string;

  /**
   * Flushes and closes the audit stream gracefully.
   */
  close(): Promise<void>;
}

export interface IAuditVerifier {
  /**
   * Verifies an audit log file (or files) line-by-line checking hash integrity
   * and sequential consistency.
   */
  verifyLogFile(filePath: string): Promise<AuditVerificationResult>;
}
