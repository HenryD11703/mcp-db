import type { OperationalLimitsPolicy, IRateLimiter } from '../contracts/cost-limits.contract.js';
import { QueryExecutionSupervisor } from './limits/execution-supervisor.js';
import { defaultOperationalLimitsPolicy } from './limits/default-limits-policy.js';
import type { EngineRiskThresholds, QueryPlanRiskProfile } from '../contracts/cost-limits.contract.js';
import { QueryPlanRiskEvaluator } from './limits/risk-evaluator.js';
import { defaultEngineRiskThresholds } from './limits/default-limits-policy.js';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  SchemaCatalog,
  SqlParserCandidate
} from '../contracts/database-adapter.js';
import { ReadOnlyPrivilegeError, SqlSecurityRejectionError } from './errors.js';
import { SqlSecurityGuard } from './security/sql-security-guard.js';

/**
 * Engine-agnostic registry and coordinator (`FR-001`, `FR-002`, Principle VII).
 * Never imports or references concrete database engines (`pg`, `mssql`, etc.);
 * communicates exclusively through `DatabaseAdapter` and `SqlParserCandidate`.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, DatabaseAdapter>();
  private readonly verifiedAdapters = new Set<string>();
  private readonly validator: SqlParserCandidate;

  constructor(validator: SqlParserCandidate = new SqlSecurityGuard()) {
    this.validator = validator;
  }

  public isAdapterVerified(adapterId: string): boolean {
    return this.verifiedAdapters.has(adapterId);
  }

  public registerAdapter(adapter: DatabaseAdapter): void {
    if (this.adapters.has(adapter.adapterId)) {
      throw new Error(`Adapter with id "${adapter.adapterId}" is already registered.`);
    }
    this.adapters.set(adapter.adapterId, adapter);
  }

  public getAdapter(adapterId: string): DatabaseAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`No DatabaseAdapter registered with id "${adapterId}".`);
    }
    return adapter;
  }

  public listAdapterIds(): ReadonlyArray<string> {
    return Array.from(this.adapters.keys());
  }

  /**
   * Executes the mandatory startup read-only preflight check across all registered adapters (`FR-003`).
   * Refuses to start if any adapter connection has effective write privileges.
   */
  public async initializeAllWithPreflight(
    signal?: AbortSignal
  ): Promise<ReadonlyMap<string, ReadOnlyVerificationResult>> {
    const results = new Map<string, ReadOnlyVerificationResult>();
    for (const [id, adapter] of this.adapters.entries()) {
      const verification = await adapter.verifyReadOnly(signal);
      if (!verification.isReadOnly || verification.violations.length > 0) {
        throw new ReadOnlyPrivilegeError(id, verification.violations);
      }
      this.verifiedAdapters.add(id);
      results.set(id, verification);
    }
    return results;
  }

    public async evaluateQueryRisk(
    adapterId: string,
    query: ParameterizedQuery,
    thresholds: EngineRiskThresholds = defaultEngineRiskThresholds
  ): Promise<QueryPlanRiskProfile> {
    const adapter = this.requireVerifiedAdapter(adapterId);
    this.assertQueryValidForDialect(query.sql, adapter.dialect);
    const evaluator = new QueryPlanRiskEvaluator(adapter);
    return await evaluator.evaluateRisk(query, adapter.dialect, thresholds);
  }

public async validateAndExplain(
    adapterId: string,
    query: ParameterizedQuery
  ): Promise<NormalizedRiskProfile> {
    const adapter = this.requireVerifiedAdapter(adapterId);
    this.assertQueryValidForDialect(query.sql, adapter.dialect);
    return await adapter.analyzeQueryPlan(query);
  }

  public async validateAndExecute(
    adapterId: string,
    query: ParameterizedQuery
  ): Promise<QueryExecutionResult> {
    const adapter = this.requireVerifiedAdapter(adapterId);
    this.assertQueryValidForDialect(query.sql, adapter.dialect);
    return await adapter.executeQuery(query);
  }

    public async validateAndExecuteWithLimits(
    adapterId: string,
    query: ParameterizedQuery,
    requesterId: string,
    limits: OperationalLimitsPolicy = defaultOperationalLimitsPolicy,
    rateLimiter?: IRateLimiter
  ): Promise<QueryExecutionResult & { truncated: boolean }> {
    const adapter = this.requireVerifiedAdapter(adapterId);
    this.assertQueryValidForDialect(query.sql, adapter.dialect);
    const supervisor = new QueryExecutionSupervisor(adapter, rateLimiter);
    return await supervisor.executeWithLimits(query, requesterId, limits);
  }

public async introspectAdapterSchema(
    adapterId: string,
    signal?: AbortSignal
  ): Promise<SchemaCatalog> {
    const adapter = this.requireVerifiedAdapter(adapterId);
    return await adapter.introspectSchema(signal);
  }

  public async closeAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.close();
    }
    this.verifiedAdapters.clear();
  }

  private requireVerifiedAdapter(adapterId: string): DatabaseAdapter {
    const adapter = this.getAdapter(adapterId);
    if (!this.verifiedAdapters.has(adapterId)) {
      throw new Error(
        `Adapter "${adapterId}" has not completed its mandatory read-only preflight verification.`
      );
    }
    return adapter;
  }

  private assertQueryValidForDialect(
    sql: string,
    dialect: DatabaseAdapter['dialect']
  ): void {
    const validation = this.validator.validateSelectOnly(sql, dialect);
    if (!validation.allowed) {
      throw new SqlSecurityRejectionError(
        validation.reasonCode ?? 'NON_SELECT_ROOT',
        dialect,
        validation.message
      );
    }
  }
}
