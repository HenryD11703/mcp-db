import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { DatabaseAdapter, QueryParameter } from './contracts/database-adapter.js';
import type {
  DelimitedOutputFormat,
  IDataMaskingEngine,
  IZeroTrustSanitizer,
  MaskingProfile
} from './contracts/security.contract.js';
import type { IAuditLogger, ISqlSanitizerForAudit } from './contracts/audit.contract.js';
import { AdapterRegistry } from './core/engine-registry.js';
import {
  AuditIntegrityViolationError,
  AuditPersistenceError,
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

export * from './contracts/database-adapter.js';
export * from './contracts/security.contract.js';
export * from './contracts/audit.contract.js';
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
export * from './core/validation/lexical-scanner.js';
export * from './core/validation/ast-validator.js';
export * from './core/validation/corpus-schema.js';
export * from './core/validation/parser-benchmark.js';
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

  const server = new Server(
    {
      name: 'db-mcp-node',
      version: '0.3.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'query_database',
        description:
          'Executes a strictly read-only SELECT query after AST validation, masks sensitive PII/financial data in memory, returns structurally delimited zero-trust records, and logs an immutable audit event.',
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
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const adapterId = String(args['adapterId'] ?? '');
    const correlationId = randomUUID();
    const requesterId =
      String(args['requesterId'] || request.params._meta?.['requesterId'] || '') ||
      `anonymous-session:${randomUUID().slice(0, 8)}`;
    const startTime = performance.now();

    let adapterEngine: string = 'postgres';
    let databaseName: string = 'default';

    try {
      const adapter = registry.getAdapter(adapterId);
      adapterEngine = adapter.dialect;
      databaseName = adapter.adapterId;
    } catch {
      // If adapter is not registered yet, default to placeholder
    }

    try {
      if (request.params.name === 'query_database') {
        const rawSql = String(args['sql'] ?? '');
        const params = (args['params'] as ReadonlyArray<QueryParameter> | undefined) ?? [];
        const format =
          (args['format'] as DelimitedOutputFormat | undefined) ?? defaultFormat;

        const evaluatedSql = sqlSanitizer.sanitizeSqlForAudit(rawSql);

        try {
          const rawResult = await registry.validateAndExecute(adapterId, { sql: rawSql, params });
          const executionTimeMs = Number((performance.now() - startTime).toFixed(2));
          const rowCount = rawResult.rows.length;

          // Mask and encapsulate results for MCP output
          const maskedDataset = maskingEngine.maskDataset(rawResult, options.maskingProfile);
          const encapsulated = sanitizer.encapsulateDataset(maskedDataset, { format });

          // Audit successful execution
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
            content: [{ type: 'text', text: encapsulated.formattedText }]
          };
        } catch (innerErr) {
          const executionTimeMs = Number((performance.now() - startTime).toFixed(2));
          let rejectionReason = innerErr instanceof Error ? innerErr.message : String(innerErr);
          let outcomeStatus: 'REJECTED_BY_GUARD' | 'CANCELLED_BY_TIMEOUT' = 'REJECTED_BY_GUARD';

          if (innerErr instanceof SqlSecurityRejectionError || innerErr instanceof SqlSecurityViolationError) {
            outcomeStatus = 'REJECTED_BY_GUARD';
            rejectionReason = `${innerErr.reasonCode}: ${innerErr.message}`;
          }

          // Immutably log rejection
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
