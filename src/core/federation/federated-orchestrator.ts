import { randomUUID } from 'node:crypto';
import type { IAuditLogger } from '../../contracts/audit.contract.js';
import type {
  EngineRiskThresholds,
  IRateLimiter,
  OperationalLimitsPolicy
} from '../../contracts/cost-limits.contract.js';
import type { DatabaseAdapter, ParameterizedQuery } from '../../contracts/database-adapter.js';
import type {
  FederatedColumnDefinition,
  FederatedQueryOptions,
  FederatedQueryResult,
  IFederatedQueryOrchestrator,
  ISessionPseudonymContext
} from '../../contracts/federated-query.contract.js';
import type { IDataMaskingEngine, ISqlSecurityGuard } from '../../contracts/security.contract.js';
import { AdapterRegistry } from '../engine-registry.js';
import {
  CostLimitExceededError,
  ReadOnlyPrivilegeError,
  SqlSecurityViolationError
} from '../errors.js';
import { DataMaskingEngine } from '../security/data-masking-engine.js';
import { SessionPseudonymContext } from '../security/session-pseudonym.js';
import { SqlSecurityGuard } from '../security/sql-security-guard.js';
import { KeyExtractor } from './key-extractor.js';
import { InMemoryHashJoin } from './memory-join.js';
import { ParameterBinder } from './parameter-binder.js';

export interface FederatedOrchestratorDependencies {
  readonly registry: AdapterRegistry;
  readonly securityGuard?: ISqlSecurityGuard;
  readonly pseudonymContext?: ISessionPseudonymContext;
  readonly maskingEngine?: IDataMaskingEngine;
  readonly auditLogger?: IAuditLogger;
  readonly engineThresholds?: EngineRiskThresholds;
  readonly limitsPolicy?: OperationalLimitsPolicy;
  readonly rateLimiter?: IRateLimiter;
}

/**
 * Secure Federated Query Orchestrator (Constitution Principles I - VII).
 * Orchestrates cross-database queries in volatile process memory without linked servers.
 */
export class FederatedQueryOrchestrator implements IFederatedQueryOrchestrator {
  private readonly registry: AdapterRegistry;
  private readonly securityGuard: ISqlSecurityGuard;
  private readonly pseudonymContext: ISessionPseudonymContext;
  private readonly maskingEngine: IDataMaskingEngine;
  private readonly auditLogger?: IAuditLogger;
  private readonly engineThresholds?: EngineRiskThresholds;
  private readonly limitsPolicy?: OperationalLimitsPolicy;
  private readonly rateLimiter?: IRateLimiter;

  constructor(dependencies: FederatedOrchestratorDependencies) {
    this.registry = dependencies.registry;
    this.securityGuard = dependencies.securityGuard ?? new SqlSecurityGuard();
    this.pseudonymContext = dependencies.pseudonymContext ?? new SessionPseudonymContext();
    this.maskingEngine = dependencies.maskingEngine ?? new DataMaskingEngine();
    this.auditLogger = dependencies.auditLogger;
    this.engineThresholds = dependencies.engineThresholds;
    this.limitsPolicy = dependencies.limitsPolicy;
    this.rateLimiter = dependencies.rateLimiter;
  }

  public async executeFederatedQuery(
    options: FederatedQueryOptions
  ): Promise<FederatedQueryResult> {
    const federationId = randomUUID();
    const overallStartTime = performance.now();
    const requesterId = options.requesterId ?? 'anonymous-agent';

    // 1. Audit Init Event
    await this.logAudit({
      correlationId: federationId,
      requesterId,
      timestamp: new Date().toISOString(),
      engine: 'orchestrator',
      database: `${options.sourceAdapterId}->${options.targetAdapterId}`,
      evaluatedSql: `FEDERATED [${options.sourceAdapterId}] -> [${options.targetAdapterId}]`,
      status: 'FEDERATED_QUERY_INIT',
      rejectionReason: null,
      executionTimeMs: 0,
      rowCount: 0
    });

    try {
      // 2. Validate and retrieve adapters
      const sourceAdapter = this.registry.getAdapter(options.sourceAdapterId);
      const targetAdapter = this.registry.getAdapter(options.targetAdapterId);

      // Verify read-only status (Principio I)
      await this.assertAdapterReadOnly(sourceAdapter, options.sourceAdapterId, options.signal);
      await this.assertAdapterReadOnly(targetAdapter, options.targetAdapterId, options.signal);

      // 3. Independent Guard AST check on Source Query (Principio I & II)
      const sourceValidation = this.securityGuard.validateQuery(
        options.sourceSql,
        sourceAdapter.dialect
      );
      if (!sourceValidation.allowed) {
        throw new SqlSecurityViolationError(
          sourceValidation.reasonCode ?? 'SYNTAX_ERROR',
          sourceAdapter.dialect,
          `Source query guard violation: ${sourceValidation.message}`
        );
      }

      const sourceQuery: ParameterizedQuery = {
        sql: options.sourceSql,
        params: [],
        signal: options.signal
      };

      // 4. Execution Plan Risk Evaluation for Source Query (Feature 004 / Principio II)
      if (this.engineThresholds) {
        const sourceRisk = await this.registry.evaluateQueryRisk(
          options.sourceAdapterId,
          sourceQuery,
          this.engineThresholds
        );
        if (sourceRisk.severity === 'CRITICAL_BLOCK') {
          throw new CostLimitExceededError(
            `Source query blocked by execution plan cost: ${sourceRisk.warnings.join('; ')}`,
            'CRITICAL_BLOCK',
            { estimatedRows: sourceRisk.estimatedRows, estimatedCost: sourceRisk.estimatedCost }
          );
        }
        if (sourceRisk.severity === 'MEDIUM_CAUTION') {
          throw new CostLimitExceededError(
            `Federated source query requires human operator approval: ${sourceRisk.warnings.join('; ')}`,
            'PENDING_APPROVAL',
            { estimatedRows: sourceRisk.estimatedRows, estimatedCost: sourceRisk.estimatedCost }
          );
        }
      }

      // 5. Execute Source Query
      const sourceExecStart = performance.now();
      const sourceResult = this.limitsPolicy
        ? await this.registry.validateAndExecuteWithLimits(
            options.sourceAdapterId,
            sourceQuery,
            requesterId,
            this.limitsPolicy,
            this.rateLimiter
          )
        : await sourceAdapter.executeQuery(sourceQuery);
      const sourceDurationMs = Math.max(0, performance.now() - sourceExecStart);

      await this.logAudit({
        correlationId: federationId,
        requesterId,
        timestamp: new Date().toISOString(),
        engine: sourceAdapter.dialect,
        database: sourceAdapter.adapterId,
        evaluatedSql: options.sourceSql,
        status: 'FEDERATED_STEP_SOURCE',
        rejectionReason: null,
        executionTimeMs: sourceDurationMs,
        rowCount: sourceResult.rows.length
      });

      // 6. Extract keys in memory (treat as untrusted data)
      const keyExtraction = KeyExtractor.extractKeys(sourceResult.rows, {
        keyColumn: options.sourceKeyColumn,
        maxKeys: options.maxKeys,
        overflowAction: options.overflowAction,
        federationId
      });

      await this.logAudit({
        correlationId: federationId,
        requesterId,
        timestamp: new Date().toISOString(),
        engine: 'orchestrator',
        database: sourceAdapter.adapterId,
        evaluatedSql: `KEYS_EXTRACTED: count=${keyExtraction.uniqueKeys.length}, truncated=${keyExtraction.isTruncated}`,
        status: 'FEDERATED_KEYS_EXTRACTED',
        rejectionReason: null,
        executionTimeMs: 0,
        rowCount: keyExtraction.uniqueKeys.length
      });

      // 7. Empty Source Short-Circuit (FR-005)
      if (keyExtraction.uniqueKeys.length === 0) {
        const totalDurationMs = Math.max(0, performance.now() - overallStartTime);
        await this.logAudit({
          correlationId: federationId,
          requesterId,
          timestamp: new Date().toISOString(),
          engine: 'orchestrator',
          database: 'federation',
          evaluatedSql: 'EMPTY_SOURCE_COMPLETED',
          status: 'FEDERATED_QUERY_COMPLETE',
          rejectionReason: null,
          executionTimeMs: totalDurationMs,
          rowCount: 0
        });

        return {
          federationId,
          status: 'EMPTY_SOURCE',
          joinType: options.joinType ?? 'LEFT',
          totalSourceRows: sourceResult.rows.length,
          totalTargetRows: 0,
          totalMergedRows: 0,
          keysProcessed: 0,
          keysTruncated: false,
          totalAvailableKeys: 0,
          columns: [],
          rows: [],
          maskedColumns: [],
          executionTimeMs: totalDurationMs,
          warnings: ['Source query returned 0 valid keys. Target query was omitted.']
        };
      }

      // 8. Bind extracted keys as typed parameters in target query template
      const parameterizedTarget = ParameterBinder.bindKeys({
        sqlTemplate: options.targetSqlTemplate,
        keys: keyExtraction.uniqueKeys,
        dialect: targetAdapter.dialect,
        federationId,
        signal: options.signal
      });

      // 9. Independent Guard AST check on expanded Target Query (Principio I & II)
      const targetValidation = this.securityGuard.validateQuery(
        parameterizedTarget.sql,
        targetAdapter.dialect
      );
      if (!targetValidation.allowed) {
        throw new SqlSecurityViolationError(
          targetValidation.reasonCode ?? 'SYNTAX_ERROR',
          targetAdapter.dialect,
          `Target query guard violation: ${targetValidation.message}`
        );
      }

      // 10. Execution Plan Risk Evaluation for Target Query (Feature 004 / Principio II)
      if (this.engineThresholds) {
        const targetRisk = await this.registry.evaluateQueryRisk(
          options.targetAdapterId,
          parameterizedTarget,
          this.engineThresholds
        );
        if (targetRisk.severity === 'CRITICAL_BLOCK') {
          throw new CostLimitExceededError(
            `Target query blocked by execution plan cost: ${targetRisk.warnings.join('; ')}`,
            'CRITICAL_BLOCK',
            { estimatedRows: targetRisk.estimatedRows, estimatedCost: targetRisk.estimatedCost }
          );
        }
        if (targetRisk.severity === 'MEDIUM_CAUTION') {
          throw new CostLimitExceededError(
            `Federated target query requires human operator approval: ${targetRisk.warnings.join('; ')}`,
            'PENDING_APPROVAL',
            { estimatedRows: targetRisk.estimatedRows, estimatedCost: targetRisk.estimatedCost }
          );
        }
      }

      // 11. Execute Target Query with typed parameters
      const targetExecStart = performance.now();
      const targetResult = this.limitsPolicy
        ? await this.registry.validateAndExecuteWithLimits(
            options.targetAdapterId,
            parameterizedTarget,
            requesterId,
            this.limitsPolicy,
            this.rateLimiter
          )
        : await targetAdapter.executeQuery(parameterizedTarget);
      const targetDurationMs = Math.max(0, performance.now() - targetExecStart);

      await this.logAudit({
        correlationId: federationId,
        requesterId,
        timestamp: new Date().toISOString(),
        engine: targetAdapter.dialect,
        database: targetAdapter.adapterId,
        evaluatedSql: parameterizedTarget.sql,
        status: 'FEDERATED_STEP_TARGET',
        rejectionReason: null,
        executionTimeMs: targetDurationMs,
        rowCount: targetResult.rows.length
      });

      // 12. In-Memory Hash Join
      const joinResult = InMemoryHashJoin.execute({
        sourceRows: sourceResult.rows,
        sourceKeyColumn: options.sourceKeyColumn,
        sourceColumns: sourceResult.columns,
        targetRows: targetResult.rows,
        targetJoinColumn: options.targetJoinColumn,
        targetColumns: targetResult.columns,
        joinType: options.joinType ?? 'LEFT'
      });

      // 13. Deterministic Pseudonymization and Masking (Principio IV)
      const targetColNameInMerged = options.sourceKeyColumn === options.targetJoinColumn
        ? `target_${options.targetJoinColumn}`
        : (joinResult.columns.find((c) => c.name === `target_${options.targetJoinColumn}`)?.name ?? options.targetJoinColumn);

      const pseudonymizedCols = new Set<string>([options.sourceKeyColumn, targetColNameInMerged]);

      // Apply pseudonymization to join key columns
      const processedRows: Array<Record<string, unknown>> = [];
      for (const row of joinResult.rows) {
        const maskedRow = { ...row };

        if (options.sourceKeyColumn in maskedRow && maskedRow[options.sourceKeyColumn] !== null && maskedRow[options.sourceKeyColumn] !== undefined) {
          maskedRow[options.sourceKeyColumn] = this.pseudonymContext.getPseudonym(
            maskedRow[options.sourceKeyColumn] as string | number
          );
        }

        if (targetColNameInMerged in maskedRow && maskedRow[targetColNameInMerged] !== null && maskedRow[targetColNameInMerged] !== undefined) {
          maskedRow[targetColNameInMerged] = this.pseudonymContext.getPseudonym(
            maskedRow[targetColNameInMerged] as string | number
          );
        }

        processedRows.push(maskedRow);
      }

      // Apply data masking engine to other sensitive columns (e.g. emails, phones, DPI, amounts)
      const maskedDataset = this.maskingEngine.maskDataset({
        columns: joinResult.columns.map((c) => ({ name: c.name, dataType: c.type })),
        rows: processedRows,
        rowCount: processedRows.length,
        durationMs: 0
      });

      // Preserve computed deterministic pseudonyms for join key columns against secondary mask rules
      for (let i = 0; i < maskedDataset.rows.length; i++) {
        const rawPseudonymRow = processedRows[i];
        const finalRow = maskedDataset.rows[i];
        if (rawPseudonymRow && finalRow) {
          for (const pCol of pseudonymizedCols) {
            if (pCol in rawPseudonymRow) {
              finalRow[pCol] = rawPseudonymRow[pCol];
            }
          }
        }
      }

      const totalDurationMs = Math.max(0, performance.now() - overallStartTime);

      const warnings: string[] = [];
      if (keyExtraction.isTruncated) {
        warnings.push(
          `Extracted keys count (${keyExtraction.totalAvailableKeys}) exceeded maximum limit (${keyExtraction.uniqueKeys.length}). Results were truncated to first ${keyExtraction.uniqueKeys.length} keys.`
        );
      }

      await this.logAudit({
        correlationId: federationId,
        requesterId,
        timestamp: new Date().toISOString(),
        engine: 'orchestrator',
        database: 'federation',
        evaluatedSql: `FEDERATED_QUERY_COMPLETE: mergedRows=${maskedDataset.rowCount}`,
        status: 'FEDERATED_QUERY_COMPLETE',
        rejectionReason: null,
        executionTimeMs: totalDurationMs,
        rowCount: maskedDataset.rowCount
      });

      const finalColumns: FederatedColumnDefinition[] = joinResult.columns.map((c) => ({
        ...c,
        isMaskedOrPseudonymized: pseudonymizedCols.has(c.name)
      }));

      return {
        federationId,
        status: keyExtraction.isTruncated ? 'TRUNCATED_KEYS' : 'SUCCESS',
        joinType: options.joinType ?? 'LEFT',
        totalSourceRows: sourceResult.rows.length,
        totalTargetRows: targetResult.rows.length,
        totalMergedRows: maskedDataset.rowCount,
        keysProcessed: keyExtraction.uniqueKeys.length,
        keysTruncated: keyExtraction.isTruncated,
        totalAvailableKeys: keyExtraction.totalAvailableKeys,
        columns: finalColumns,
        rows: maskedDataset.rows,
        maskedColumns: Array.from(pseudonymizedCols),
        executionTimeMs: totalDurationMs,
        warnings: warnings.length > 0 ? warnings : undefined
      };
    } catch (err: unknown) {
      const totalDurationMs = Math.max(0, performance.now() - overallStartTime);
      const errMsg = err instanceof Error ? err.message : String(err);

      await this.logAudit({
        correlationId: federationId,
        requesterId,
        timestamp: new Date().toISOString(),
        engine: 'orchestrator',
        database: 'federation',
        evaluatedSql: `FAILED: ${errMsg}`,
        status: 'FEDERATED_QUERY_FAILED',
        rejectionReason: errMsg,
        executionTimeMs: totalDurationMs,
        rowCount: 0
      });

      throw err;
    }
  }

  private async assertAdapterReadOnly(
    adapter: DatabaseAdapter,
    adapterId: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.registry.isAdapterVerified(adapterId)) {
      const verification = await adapter.verifyReadOnly(signal);
      if (!verification.isReadOnly || verification.violations.length > 0) {
        throw new ReadOnlyPrivilegeError(adapterId, verification.violations);
      }
    }
  }

  private async logAudit(entry: {
    correlationId: string;
    requesterId: string;
    timestamp: string;
    engine: string;
    database: string;
    evaluatedSql: string;
    status: any;
    rejectionReason: string | null;
    executionTimeMs: number;
    rowCount: number;
  }): Promise<void> {
    if (!this.auditLogger) return;
    try {
      await this.auditLogger.logEvent(entry);
    } catch {
      // In audit fail-open or test scenarios, ignore logger errors if not configured strictly
    }
  }
}
