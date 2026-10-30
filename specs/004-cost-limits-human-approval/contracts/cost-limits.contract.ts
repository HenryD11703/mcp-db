import { EngineDialect, ParameterizedQuery, QueryParameter, ColumnDescriptor, QueryExecutionResult } from '../../../src/contracts/database-adapter.js';

export type RiskSeverity = 'LOW' | 'MEDIUM_CAUTION' | 'CRITICAL_BLOCK';

export interface QueryPlanRiskProfile {
  readonly severity: RiskSeverity;
  readonly estimatedCost: number;
  readonly estimatedRows: number;
  readonly hasFullScan: boolean;
  readonly scannedTables: ReadonlyArray<string>;
  readonly hasCartesianJoin: boolean;
  readonly isVerifiable: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly rawPlanSummary?: string;
}

export interface EngineRiskThresholds {
  readonly largeTablesBlocklist: ReadonlyArray<string>;
  readonly maxEstimatedRowsCaution: number;
  readonly maxEstimatedRowsBlock: number;
  readonly maxEstimatedCostCaution: number;
  readonly maxEstimatedCostBlock: number;
  readonly prohibitCartesianJoins: boolean;
  readonly planTimeoutMs: number;
}

export interface OperationalLimitsPolicy {
  readonly executionTimeoutMs: number;
  readonly maxRowsLimit: number;
  readonly rateLimitPerClientPerMinute: number;
  readonly rateLimitGlobalPerMinute: number;
}

export interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly level?: 'CLIENT' | 'GLOBAL';
  readonly retryAfterSeconds?: number;
  readonly currentCount?: number;
  readonly limit?: number;
}

export interface IRateLimiter {
  checkLimit(requesterId: string): RateLimitCheckResult;
  recordQuery(requesterId: string): void;
  reset(): void;
}

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface PendingApprovalTicket {
  readonly approvalId: string;
  readonly correlationId: string;
  readonly requesterId: string;
  readonly engine: EngineDialect;
  readonly database: string;
  readonly sql: string;
  readonly params: ReadonlyArray<QueryParameter>;
  readonly riskProfile: QueryPlanRiskProfile;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly resolutionReason?: string;
}

export interface ApprovedQueryResult {
  readonly approvalId: string;
  readonly columns: ReadonlyArray<ColumnDescriptor>;
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
  readonly truncated: boolean;
  readonly executedAt: string;
  readonly expiresAt: string;
}

export interface IPendingApprovalStore {
  saveTicket(ticket: PendingApprovalTicket): Promise<void>;
  getTicket(approvalId: string): Promise<PendingApprovalTicket | null>;
  listPendingTickets(): Promise<ReadonlyArray<PendingApprovalTicket>>;
  resolveTicket(
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
    operatorIdentity: string,
    reason?: string
  ): Promise<PendingApprovalTicket>;
  saveApprovedResult(result: ApprovedQueryResult): Promise<void>;
  getApprovedResult(approvalId: string): Promise<ApprovedQueryResult | null>;
  purgeExpiredTickets(): Promise<number>;
}

export interface IQueryPlanRiskEvaluator {
  evaluateRisk(
    query: ParameterizedQuery,
    dialect: EngineDialect,
    thresholds: EngineRiskThresholds
  ): Promise<QueryPlanRiskProfile>;
}

export interface IQueryExecutionSupervisor {
  executeWithLimits(
    query: ParameterizedQuery,
    requesterId: string,
    limits: OperationalLimitsPolicy
  ): Promise<QueryExecutionResult & { truncated: boolean }>;
}
