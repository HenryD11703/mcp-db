import type { EngineDialect, RejectionReasonCode } from '../contracts/database-adapter.js';
import type { SecurityViolationCode } from '../contracts/security.contract.js';

export class ReadOnlyPrivilegeError extends Error {
  public readonly adapterId: string;
  public readonly violations: ReadonlyArray<string>;

  constructor(adapterId: string, violations: ReadonlyArray<string>) {
    super(
      `Read-only preflight check failed for adapter "${adapterId}": detected ${violations.length} privilege violation(s).`
    );
    this.name = 'ReadOnlyPrivilegeError';
    this.adapterId = adapterId;
    this.violations = violations;
  }
}

export class PreflightFatalError extends Error {
  public readonly adapterId: string;
  public readonly violations: ReadonlyArray<string>;
  public readonly exitCode: number = 1;

  constructor(adapterId: string, violations: ReadonlyArray<string>) {
    super(
      `FATAL PREFLIGHT FAILURE on adapter "${adapterId}": Refusing to start MCP server because write privileges were detected (${violations.join('; ')}).`
    );
    this.name = 'PreflightFatalError';
    this.adapterId = adapterId;
    this.violations = violations;
  }
}

export class SqlSecurityRejectionError extends Error {
  public readonly reasonCode: RejectionReasonCode;
  public readonly dialect: EngineDialect;

  constructor(reasonCode: RejectionReasonCode, dialect: EngineDialect, detail?: string) {
    super(
      `SQL security guard rejected query for dialect "${dialect}" [${reasonCode}]${detail ? `: ${detail}` : '.'}`
    );
    this.name = 'SqlSecurityRejectionError';
    this.reasonCode = reasonCode;
    this.dialect = dialect;
  }
}

export class SqlSecurityViolationError extends Error {
  public readonly reasonCode: SecurityViolationCode;
  public readonly dialect: EngineDialect;
  public readonly detectedInStage?: 'lexical' | 'ast';

  constructor(
    reasonCode: SecurityViolationCode,
    dialect: EngineDialect,
    detail?: string,
    detectedInStage?: 'lexical' | 'ast'
  ) {
    super(
      `SQL security violation for dialect "${dialect}" [${reasonCode}]${detail ? `: ${detail}` : '.'}`
    );
    this.name = 'SqlSecurityViolationError';
    this.reasonCode = reasonCode;
    this.dialect = dialect;
    this.detectedInStage = detectedInStage;
  }
}

export class DataMaskingError extends Error {
  public readonly ruleId?: string;

  constructor(message: string, ruleId?: string) {
    super(`Data masking error${ruleId ? ` in rule "${ruleId}"` : ''}: ${message}`);
    this.name = 'DataMaskingError';
    this.ruleId = ruleId;
  }
}

export class QueryPlanAnalysisError extends Error {
  public readonly adapterId: string;

  constructor(adapterId: string, sanitizedReason: string) {
    super(`Execution plan analysis failed on adapter "${adapterId}": ${sanitizedReason}`);
    this.name = 'QueryPlanAnalysisError';
    this.adapterId = adapterId;
  }
}

export class QueryCancelledError extends Error {
  public readonly adapterId: string;

  constructor(adapterId: string) {
    super(`Query execution was cancelled via AbortSignal on adapter "${adapterId}".`);
    this.name = 'QueryCancelledError';
    this.adapterId = adapterId;
  }
}

export class AuditPersistenceError extends Error {
  public readonly targetPath: string;
  public readonly causeError?: Error;

  constructor(targetPath: string, message: string, causeError?: Error) {
    super(`Audit log persistence failure [FAIL-CLOSED] at "${targetPath}": ${message}`);
    this.name = 'AuditPersistenceError';
    this.targetPath = targetPath;
    this.causeError = causeError;
  }
}

export class AuditIntegrityViolationError extends Error {
  public readonly sequenceNumber: number;
  public readonly correlationId: string;
  public readonly reason: string;

  constructor(sequenceNumber: number, correlationId: string, reason: string) {
    super(
      `Audit log integrity violation detected at sequence #${sequenceNumber} (correlation: ${correlationId}): ${reason}`
    );
    this.name = 'AuditIntegrityViolationError';
    this.sequenceNumber = sequenceNumber;
    this.correlationId = correlationId;
    this.reason = reason;
  }
}

export class CostLimitExceededError extends Error {
  public readonly reasonCode: string;
  public readonly metrics: {
    readonly estimatedRows?: number;
    readonly estimatedCost?: number;
    readonly fullScanTable?: string;
  };

  constructor(
    message: string,
    reasonCode: string,
    metrics: { estimatedRows?: number; estimatedCost?: number; fullScanTable?: string } = {}
  ) {
    super(`Cost limit exceeded [${reasonCode}]: ${message}`);
    this.name = 'CostLimitExceededError';
    this.reasonCode = reasonCode;
    this.metrics = metrics;
  }
}

export class QueryExecutionTimeoutError extends Error {
  public readonly timeoutMs: number;
  public readonly adapterId: string;

  constructor(adapterId: string, timeoutMs: number) {
    super(`Query execution timed out after ${timeoutMs}ms on adapter "${adapterId}". Cancel signal dispatched.`);
    this.name = 'QueryExecutionTimeoutError';
    this.adapterId = adapterId;
    this.timeoutMs = timeoutMs;
  }
}

export class RateLimitExceededError extends Error {
  public readonly level: 'CLIENT' | 'GLOBAL';
  public readonly limit: number;
  public readonly retryAfterSeconds: number;

  constructor(level: 'CLIENT' | 'GLOBAL', limit: number, retryAfterSeconds: number) {
    super(
      `Rate limit exceeded (${level} level: max ${limit} queries/min). Please retry after ${retryAfterSeconds}s.`
    );
    this.name = 'RateLimitExceededError';
    this.level = level;
    this.limit = limit;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class PendingApprovalRequiredError extends Error {
  public readonly approvalId: string;
  public readonly riskSummary: Record<string, unknown>;

  constructor(approvalId: string, riskSummary: Record<string, unknown>) {
    super(`Query requires explicit human operator approval [Ticket ID: ${approvalId}].`);
    this.name = 'PendingApprovalRequiredError';
    this.approvalId = approvalId;
    this.riskSummary = riskSummary;
  }
}



export class FederatedQueryError extends Error {
  public readonly federationId?: string;
  public readonly step?: string;

  constructor(message: string, federationId?: string, step?: string) {
    super(
      `Federated query error${step ? ` at step "${step}"` : ''}${federationId ? ` [Federation ID: ${federationId}]` : ''}: ${message}`
    );
    this.name = 'FederatedQueryError';
    this.federationId = federationId;
    this.step = step;
  }
}

export class FederatedKeyLimitExceededError extends FederatedQueryError {
  public readonly totalKeys: number;
  public readonly maxKeys: number;

  constructor(totalKeys: number, maxKeys: number, federationId?: string) {
    super(
      `Extracted keys count (${totalKeys}) exceeds strict maximum allowed limit of ${maxKeys}. Refusing execution under overflowAction='fail'.`,
      federationId,
      'EXTRACTING_KEYS'
    );
    this.name = 'FederatedKeyLimitExceededError';
    this.totalKeys = totalKeys;
    this.maxKeys = maxKeys;
  }
}
