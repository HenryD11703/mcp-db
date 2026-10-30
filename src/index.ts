import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { DatabaseAdapter, EngineDialect, QueryParameter } from './contracts/database-adapter.js';
import type {
  DelimitedOutputFormat,
  IDataMaskingEngine,
  IZeroTrustSanitizer,
  MaskingProfile
} from './contracts/security.contract.js';
import type { AuditQueryOutcome, IAuditLogger, ISqlSanitizerForAudit } from './contracts/audit.contract.js';
import type {
  EngineRiskThresholds,
  IPendingApprovalStore,
  IRateLimiter,
  OperationalLimitsPolicy,
  PendingApprovalTicket
} from './contracts/cost-limits.contract.js';
import { AdapterRegistry } from './core/engine-registry.js';
import { DiscoveryTools } from './core/tools/discovery-tools.js';
import { FederatedTools } from './core/tools/federated-tools.js';
import { FederatedQueryOrchestrator } from './core/federation/federated-orchestrator.js';
import type { ISessionPseudonymContext } from './contracts/federated-query.contract.js';
import {
  AuditIntegrityViolationError,
  AuditPersistenceError,
  CostLimitExceededError,
  QueryExecutionTimeoutError,
  RateLimitExceededError,
  SqlSecurityRejectionError,
  SqlSecurityViolationError
} from './core/errors.js';
import { DataMaskingEngine } from './core/security/data-masking-engine.js';
import {
  StartupPreflightGate,
  type StartupPreflightGateOptions
} from './core/security/startup-preflight-gate.js';
import { ZeroTrustSanitizer } from './core/security/zero-trust-sanitizer.js';
import { AuditLogger } from './core/audit/audit-logger.js';
import { SqlSanitizerForAudit } from './core/audit/sql-sanitizer.js';
import { AuditVerifier } from './core/audit/audit-verifier.js';
import { AuditRotator } from './core/audit/audit-rotator.js';
import { TwoTierRateLimiter } from './core/limits/rate-limiter.js';
import { PendingApprovalStore } from './core/limits/pending-approval-store.js';
import {
  defaultEngineRiskThresholds,
  defaultOperationalLimitsPolicy
} from './core/limits/default-limits-policy.js';

export * from './contracts/database-adapter.js';
export * from './contracts/security.contract.js';
export * from './contracts/audit.contract.js';
export * from './contracts/cost-limits.contract.js';
export * from './contracts/legacy-discovery.contract.js';
export * from './core/errors.js';
export * from './core/engine-registry.js';
export * from './core/security/sql-security-guard.js';
export * from './core/security/startup-preflight-gate.js';
export * from './core/security/masking-rules.js';
export * from './core/security/default-masking-profile.js';
export * from './core/security/data-masking-engine.js';
export * from './core/security/zero-trust-sanitizer.js';
export * from './core/audit/audit-canonicalizer.js';
export * from './core/audit/audit-hasher.js';
export * from './core/audit/audit-logger.js';
export * from './core/audit/sql-sanitizer.js';
export * from './core/audit/audit-verifier.js';
export * from './core/audit/audit-rotator.js';
export * from './core/limits/risk-evaluator.js';
export * from './core/limits/rate-limiter.js';
export * from './core/limits/execution-supervisor.js';
export * from './core/limits/pending-approval-store.js';
export * from './core/limits/default-limits-policy.js';
export * from './core/validation/lexical-scanner.js';
export * from './core/validation/ast-validator.js';
export * from './core/validation/corpus-schema.js';
export * from './core/validation/parser-benchmark.js';
export * from './core/discovery/catalog-service.js';
export * from './core/discovery/relationship-inference-engine.js';
export * from './core/discovery/inference-scoring.js';
export * from './core/discovery/name-tokenizer.js';
export * from './core/discovery/table-resolution.js';
export * from './core/glossary/glossary-loader.js';
export * from './core/glossary/glossary-index.js';
export * from './core/glossary/glossary-service.js';
export * from './core/tools/discovery-tools.js';
export * from './contracts/federated-query.contract.js';
export * from './core/security/session-pseudonym.js';
export * from './core/federation/key-extractor.js';
export * from './core/federation/parameter-binder.js';
export * from './core/federation/memory-join.js';
export * from './core/federation/federated-orchestrator.js';
export * from './core/tools/federated-tools.js';
export * from './adapters/postgres/postgres-adapter.js';
export * from './adapters/postgres/postgres-plan-parser.js';
export * from './adapters/sqlserver/sqlserver-adapter.js';
export * from './adapters/sqlserver/sqlserver-plan-parser.js';

export interface DatabaseMcpServerOptions {
  readonly maskingEngine?: IDataMaskingEngine;
  readonly maskingProfile?: MaskingProfile;
  readonly zeroTrustSanitizer?: IZeroTrustSanitizer;
  readonly defaultOutputFormat?: DelimitedOutputFormat;
  readonly auditLogger?: IAuditLogger;
  readonly sqlSanitizer?: ISqlSanitizerForAudit;
  readonly auditLogPath?: string;
  readonly rateLimiter?: IRateLimiter;
  readonly limitsPolicy?: OperationalLimitsPolicy;
  readonly engineThresholds?: EngineRiskThresholds;
  readonly approvalStore?: IPendingApprovalStore;
  /** Overrides the discovery tools (catalog, relationship inference, business glossary). */
  readonly discoveryTools?: DiscoveryTools;
  /** Glossary file path; defaults to GLOSSARY_PATH or docs/glossary.yaml. */
  readonly glossaryPath?: string;
  readonly federatedTools?: FederatedTools;
  readonly pseudonymContext?: ISessionPseudonymContext;
}

const QUERY_PARAMS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['name', 'type', 'value'],
    properties: {
      name: { type: 'string' },
      type: {
        type: 'string',
        enum: ['string', 'number', 'boolean', 'date', 'null']
      },
      value: {}
    }
  }
} as const;

export function createDatabaseMcpServer(
  registry: AdapterRegistry,
  options: DatabaseMcpServerOptions = {}
): Server {
  const maskingEngine = options.maskingEngine ?? new DataMaskingEngine();
  const sanitizer = options.zeroTrustSanitizer ?? new ZeroTrustSanitizer();
  const defaultFormat = options.defaultOutputFormat ?? 'semantic_xml';

  const auditLogPath =
    options.auditLogPath || process.env['AUDIT_LOG_PATH'] || 'audit.jsonl';
  const auditLogger =
    options.auditLogger ?? new AuditLogger({ logFilePath: auditLogPath });
  const sqlSanitizer = options.sqlSanitizer ?? new SqlSanitizerForAudit();

  const limitsPolicy = options.limitsPolicy ?? defaultOperationalLimitsPolicy;
  const engineThresholds = options.engineThresholds ?? defaultEngineRiskThresholds;
  const rateLimiter =
    options.rateLimiter ??
    new TwoTierRateLimiter({
      clientLimitPerMinute: limitsPolicy.rateLimitPerClientPerMinute,
      globalLimitPerMinute: limitsPolicy.rateLimitGlobalPerMinute
    });
  const approvalStore = options.approvalStore ?? new PendingApprovalStore();
  const discovery =
    options.discoveryTools ??
    new DiscoveryTools({
      registry,
      auditLogger,
      sanitizer,
      ...(options.glossaryPath ? { glossaryPath: options.glossaryPath } : {})
    });

  const federatedTools =
    options.federatedTools ??
    new FederatedTools(
      new FederatedQueryOrchestrator({
        registry,
        auditLogger,
        maskingEngine,
        pseudonymContext: options.pseudonymContext
      })
    );

  const server = new Server(
    {
      name: 'db-mcp-node',
      version: '0.4.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...discovery.definitions(),
      ...federatedTools.definitions(),
      {
        name: 'query_database',
        description:
          'Executes a strictly read-only SELECT query after AST validation and execution plan cost evaluation, masks sensitive PII/financial data in memory, returns structurally delimited zero-trust records, and logs an immutable audit event.',
        inputSchema: {
          type: 'object',
          required: ['adapterId', 'sql'],
          properties: {
            adapterId: { type: 'string' },
            sql: { type: 'string' },
            params: QUERY_PARAMS_SCHEMA,
            format: {
              type: 'string',
              enum: ['semantic_xml', 'strict_json']
            }
          }
        }
      },
      {
        name: 'explain_query',
        description:
          'Validates a read-only SELECT query, returns its NormalizedRiskProfile, and records an audit event without data retrieval.',
        inputSchema: {
          type: 'object',
          required: ['adapterId', 'sql'],
          properties: {
            adapterId: { type: 'string' },
            sql: { type: 'string' },
            params: QUERY_PARAMS_SCHEMA
          }
        }
      },
      {
        name: 'introspect_schema',
        description:
          'Returns the normalized SchemaCatalog (tables, views, columns, primary and foreign keys) and records an audit event.',
        inputSchema: {
          type: 'object',
          required: ['adapterId'],
          properties: {
            adapterId: { type: 'string' }
          }
        }
      },
      {
        name: 'get_query_result',
        description:
          'Passively retrieves the execution status or masked results of a query that was previously queued for human approval (PENDING_APPROVAL). Excludes any approval capability.',
        inputSchema: {
          type: 'object',
          required: ['approvalId'],
          properties: {
            approvalId: {
              type: 'string',
              description: 'The unique approval ticket identifier (e.g. appr_...)'
            }
          }
        }
      },
      {
        name: 'list_adapters',
        description:
          'Lists all configured and verified database adapters in this MCP server, including their adapterId, SQL dialect (postgres, tsql), and whether they are active.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let adapterId = String(args['adapterId'] ?? '').trim();
    if (!adapterId && registry.listAdapterIds().length === 1) {
      adapterId = registry.listAdapterIds()[0]!;
      args['adapterId'] = adapterId;
    }
    const correlationId = randomUUID();
    const requesterId =
      String(args['requesterId'] || request.params._meta?.['requesterId'] || '') ||
      `anonymous-session:${randomUUID().slice(0, 8)}`;
    const startTime = performance.now();

    let adapterEngine: string = 'postgres';
    let databaseName: string = 'default';

    try {
      if (adapterId) {
        const adapter = registry.getAdapter(adapterId);
        adapterEngine = adapter.dialect;
        databaseName = adapter.adapterId;
      }
    } catch {
      // If adapter is not registered yet, default to placeholder
    }

    try {
      if (request.params.name === 'list_adapters') {
        const ids = registry.listAdapterIds();
        const adapters = ids.map((id) => {
          const adapter = registry.getAdapter(id);
          return {
            adapterId: adapter.adapterId,
            dialect: adapter.dialect
          };
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  adapters,
                  count: adapters.length,
                  defaultAdapterId: adapters.length === 1 ? adapters[0]?.adapterId : null
                },
                null,
                2
              )
            }
          ]
        };
      }

      if (discovery.handles(request.params.name)) {
        return await discovery.call(request.params.name, args, { requesterId, correlationId });
      }

      if (federatedTools.handles(request.params.name)) {
        return await federatedTools.call(request.params.name, args, { requesterId, correlationId });
      }

      if (request.params.name === 'query_database') {
        const rawSql = String(args['sql'] ?? '');
        const params = (args['params'] as ReadonlyArray<QueryParameter> | undefined) ?? [];
        const format =
          (args['format'] as DelimitedOutputFormat | undefined) ?? defaultFormat;

        const evaluatedSql = sqlSanitizer.sanitizeSqlForAudit(rawSql);

        // 1. Evaluate execution plan risk prior to execution
        const riskProfile = await registry.evaluateQueryRisk(
          adapterId,
          { sql: rawSql, params },
          engineThresholds
        );

        // 2. Critical Block: prohibit execution completely
        if (riskProfile.severity === 'CRITICAL_BLOCK') {
          const rejectionReason = `BLOCKED_BY_COST: ${riskProfile.warnings.join('; ')}`;
          await auditLogger.logEvent({
            correlationId,
            requesterId,
            timestamp: new Date().toISOString(),
            engine: adapterEngine,
            database: databaseName,
            evaluatedSql,
            status: 'BLOCKED_BY_COST',
            rejectionReason,
            executionTimeMs: Number((performance.now() - startTime).toFixed(2)),
            rowCount: 0
          });

          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'BLOCKED_BY_COST',
                    message: 'Consulta bloqueada preventivamente por exceder los umbrales de riesgo.',
                    warnings: riskProfile.warnings,
                    riskProfile
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        // 3. Medium Caution: route asynchronously to human approval
        if (riskProfile.severity === 'MEDIUM_CAUTION') {
          const approvalId = `appr_${randomUUID()}`;
          const ticket: PendingApprovalTicket = {
            approvalId,
            correlationId,
            requesterId,
            engine: adapterEngine as EngineDialect,
            database: databaseName,
            sql: rawSql,
            params,
            riskProfile,
            status: 'PENDING',
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
          };
          await approvalStore.saveTicket(ticket);

          await auditLogger.logEvent({
            correlationId,
            requesterId,
            timestamp: new Date().toISOString(),
            engine: adapterEngine,
            database: databaseName,
            evaluatedSql,
            status: 'PENDING_APPROVAL',
            rejectionReason: riskProfile.warnings.join('; '),
            executionTimeMs: Number((performance.now() - startTime).toFixed(2)),
            rowCount: 0
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'PENDING_APPROVAL',
                    approvalId,
                    riskSummary: {
                      estimatedRows: riskProfile.estimatedRows,
                      estimatedCost: riskProfile.estimatedCost,
                      warnings: riskProfile.warnings
                    },
                    message: `La consulta supera el umbral de precaución y requiere autorización humana explícita. Un operador humano debe autorizarla mediante: db-mcp approve ${approvalId}`
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        // 4. Low Risk: execute with operational limits (timeouts, rows ceiling, rate limits)
        try {
          const rawResult = await registry.validateAndExecuteWithLimits(
            adapterId,
            { sql: rawSql, params },
            requesterId,
            limitsPolicy,
            rateLimiter
          );
          const executionTimeMs = Number((performance.now() - startTime).toFixed(2));
          const rowCount = rawResult.rows.length;

          const maskedDataset = maskingEngine.maskDataset(rawResult, options.maskingProfile);
          const encapsulated = sanitizer.encapsulateDataset(maskedDataset, { format });

          let outputText = encapsulated.formattedText;
          if (rawResult.truncated) {
            outputText += `\n<!-- ADVERTENCIA: El conjunto de resultados excedió el límite configurado de ${limitsPolicy.maxRowsLimit} filas y fue acotado de forma segura (truncated: true). -->`;
          }

          await auditLogger.logEvent({
            correlationId,
            requesterId,
            timestamp: new Date().toISOString(),
            engine: adapterEngine,
            database: databaseName,
            evaluatedSql,
            status: 'EXECUTED',
            rejectionReason: null,
            executionTimeMs,
            rowCount
          });

          return {
            content: [{ type: 'text', text: outputText }]
          };
        } catch (innerErr) {
          const executionTimeMs = Number((performance.now() - startTime).toFixed(2));
          let rejectionReason = innerErr instanceof Error ? innerErr.message : String(innerErr);
          let outcomeStatus: AuditQueryOutcome = 'REJECTED_BY_GUARD';

          if (innerErr instanceof QueryExecutionTimeoutError) {
            outcomeStatus = 'CANCELLED_BY_TIMEOUT';
          } else if (innerErr instanceof RateLimitExceededError) {
            outcomeStatus = 'REJECTED_BY_GUARD';
          } else if (
            innerErr instanceof SqlSecurityRejectionError ||
            innerErr instanceof SqlSecurityViolationError
          ) {
            outcomeStatus = 'REJECTED_BY_GUARD';
            rejectionReason = `${innerErr.reasonCode}: ${innerErr.message}`;
          }

          await auditLogger.logEvent({
            correlationId,
            requesterId,
            timestamp: new Date().toISOString(),
            engine: adapterEngine,
            database: databaseName,
            evaluatedSql,
            status: outcomeStatus,
            rejectionReason,
            executionTimeMs,
            rowCount: 0
          });

          throw innerErr;
        }
      }

      if (request.params.name === 'get_query_result') {
        const approvalId = String(args['approvalId'] ?? '');
        const ticket = await approvalStore.getTicket(approvalId);

        if (!ticket) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `[ERROR] No se encontró ninguna solicitud con ID de aprobación "${approvalId}".`
              }
            ]
          };
        }

        if (ticket.status === 'PENDING') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'PENDING_APPROVAL',
                    approvalId,
                    message:
                      'La consulta aún se encuentra en espera de autorización por parte de un operador humano.'
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (ticket.status === 'REJECTED') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'REJECTED',
                    approvalId,
                    message: 'La consulta fue rechazada por el operador humano.',
                    reason: ticket.resolutionReason
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (ticket.status === 'EXPIRED') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'EXPIRED',
                    approvalId,
                    message: 'El ticket de aprobación ha expirado tras superar su tiempo de vida (TTL).'
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        if (ticket.status === 'APPROVED') {
          const cached = await approvalStore.getApprovedResult(approvalId);
          if (cached) {
            const masked = maskingEngine.maskDataset({ ...cached, durationMs: 0 }, options.maskingProfile);
            const encapsulated = sanitizer.encapsulateDataset(masked, { format: defaultFormat });
            return {
              content: [{ type: 'text', text: encapsulated.formattedText }]
            };
          }

          // Execute query if not yet executed
          const rawResult = await registry.validateAndExecute(ticket.database, {
            sql: ticket.sql,
            params: ticket.params
          });
          const masked = maskingEngine.maskDataset(rawResult, options.maskingProfile);
          const encapsulated = sanitizer.encapsulateDataset(masked, { format: defaultFormat });

          await approvalStore.saveApprovedResult({
            approvalId,
            columns: rawResult.columns,
            rows: rawResult.rows,
            rowCount: rawResult.rowCount,
            truncated: rawResult.rows.length > limitsPolicy.maxRowsLimit,
            executedAt: new Date().toISOString(),
            expiresAt: ticket.expiresAt
          });

          await auditLogger.logEvent({
            correlationId: ticket.correlationId,
            requesterId,
            timestamp: new Date().toISOString(),
            engine: ticket.engine,
            database: ticket.database,
            evaluatedSql: sqlSanitizer.sanitizeSqlForAudit(ticket.sql),
            status: 'EXECUTED',
            rejectionReason: null,
            executionTimeMs: Number((performance.now() - startTime).toFixed(2)),
            rowCount: rawResult.rowCount
          });

          return {
            content: [{ type: 'text', text: encapsulated.formattedText }]
          };
        }
      }

      if (request.params.name === 'explain_query') {
        const rawSql = String(args['sql'] ?? '');
        const params = (args['params'] as ReadonlyArray<QueryParameter> | undefined) ?? [];
        const evaluatedSql = sqlSanitizer.sanitizeSqlForAudit(rawSql);

        try {
          const profile = await registry.validateAndExplain(adapterId, { sql: rawSql, params });
          const executionTimeMs = Number((performance.now() - startTime).toFixed(2));

          await auditLogger.logEvent({
            correlationId,
            requesterId,
            timestamp: new Date().toISOString(),
            engine: adapterEngine,
            database: databaseName,
            evaluatedSql,
            status: 'EXECUTED',
            rejectionReason: null,
            executionTimeMs,
            rowCount: 0
          });

          return {
            content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }]
          };
        } catch (innerErr) {
          const executionTimeMs = Number((performance.now() - startTime).toFixed(2));
          await auditLogger.logEvent({
            correlationId,
            requesterId,
            timestamp: new Date().toISOString(),
            engine: adapterEngine,
            database: databaseName,
            evaluatedSql,
            status: 'REJECTED_BY_GUARD',
            rejectionReason: innerErr instanceof Error ? innerErr.message : String(innerErr),
            executionTimeMs,
            rowCount: 0
          });
          throw innerErr;
        }
      }

      if (request.params.name === 'introspect_schema') {
        const catalog = await registry.introspectAdapterSchema(adapterId);
        databaseName = catalog.databaseName || databaseName;
        adapterEngine = catalog.dialect || adapterEngine;
        const executionTimeMs = Number((performance.now() - startTime).toFixed(2));

        await auditLogger.logEvent({
          correlationId,
          requesterId,
          timestamp: new Date().toISOString(),
          engine: adapterEngine,
          database: databaseName,
          evaluatedSql: 'INTROSPECT_SCHEMA',
          status: 'EXECUTED',
          rejectionReason: null,
          executionTimeMs,
          rowCount: catalog.tables.length
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(catalog, null, 2) }]
        };
      }
    } catch (err) {
      if (
        err instanceof SqlSecurityRejectionError ||
        err instanceof SqlSecurityViolationError
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                allowed: false,
                reasonCode: err.reasonCode,
                dialect: err.dialect,
                message: err.message
              })
            }
          ]
        };
      }
      throw err;
    }

    throw new Error(`Unknown MCP tool: ${request.params.name}`);
  });

  return server;
}

export async function bootstrapAdapters(
  adapters: ReadonlyArray<DatabaseAdapter>,
  preflightOptions?: StartupPreflightGateOptions
): Promise<AdapterRegistry> {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) {
    registry.registerAdapter(adapter);
  }
  const gate = new StartupPreflightGate(registry, preflightOptions);
  await gate.verifyAndEnforceStartup();
  return registry;
}
