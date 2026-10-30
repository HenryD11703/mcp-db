import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { IAuditLogger } from '../../contracts/audit.contract.js';
import {
  isCatalogCapable,
  type CatalogSnapshot,
  type DiscoveryAuditAction,
  type IRelationshipInferenceEngine
} from '../../contracts/legacy-discovery.contract.js';
import type { IZeroTrustSanitizer } from '../../contracts/security.contract.js';
import type { AdapterRegistry } from '../engine-registry.js';
import { CatalogService, parseTableArgument } from '../discovery/catalog-service.js';
import { RelationshipInferenceEngine } from '../discovery/relationship-inference-engine.js';
import { parseQualifiedName, resolveTable, TableResolutionError } from '../discovery/table-resolution.js';
import { GlossaryService } from '../glossary/glossary-service.js';
import { wrapUntrustedMetadata } from './discovery-output.js';

const ADAPTER_ID = z.string().min(1).max(128);

const listTablesArgs = z
  .object({
    adapterId: ADAPTER_ID,
    schema: z.string().max(128).optional(),
    namePattern: z.string().max(128).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().max(256).optional()
  })
  .passthrough();

const describeTableArgs = z
  .object({
    adapterId: ADAPTER_ID,
    schema: z.string().max(128).optional(),
    table: z.string().min(1).max(257)
  })
  .passthrough();

const inferArgs = z
  .object({
    adapterId: ADAPTER_ID,
    tables: z.array(z.string().min(1).max(257)).min(1).max(50),
    minConfidence: z.number().min(0).max(1).optional(),
    verifyStatistically: z.boolean().optional()
  })
  .passthrough();

const searchArgs = z
  .object({
    adapterId: ADAPTER_ID.optional(),
    query: z.string().min(2).max(200),
    limit: z.number().int().min(1).max(50).optional()
  })
  .passthrough();

export const DISCOVERY_TOOL_NAMES = [
  'list_tables',
  'describe_table',
  'infer_table_relationships',
  'search_glossary'
] as const;
export type DiscoveryToolName = (typeof DISCOVERY_TOOL_NAMES)[number];

export interface DiscoveryToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

export interface DiscoveryCallContext {
  readonly requesterId: string;
  readonly correlationId: string;
}

export interface DiscoveryToolsOptions {
  readonly registry: AdapterRegistry;
  readonly auditLogger: IAuditLogger;
  readonly sanitizer: IZeroTrustSanitizer;
  readonly glossary?: GlossaryService;
  readonly glossaryPath?: string;
  readonly engine?: IRelationshipInferenceEngine;
  readonly catalogTtlMs?: number;
}

function auditTarget(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
}

export class DiscoveryTools {
  public readonly glossary: GlossaryService;
  public readonly catalog: CatalogService;
  private readonly registry: AdapterRegistry;
  private readonly auditLogger: IAuditLogger;
  private readonly sanitizer: IZeroTrustSanitizer;
  private readonly engine: IRelationshipInferenceEngine;
  private readonly glossaryReady: Promise<unknown>;

  constructor(options: DiscoveryToolsOptions) {
    this.registry = options.registry;
    this.auditLogger = options.auditLogger;
    this.sanitizer = options.sanitizer;
    this.engine = options.engine ?? new RelationshipInferenceEngine();
    const glossaryPath = options.glossaryPath ?? process.env['GLOSSARY_PATH'];
    this.glossary =
      options.glossary ?? new GlossaryService(glossaryPath ? { filePath: glossaryPath } : {});
    this.catalog = new CatalogService({
      loader: (adapterId, signal) => this.loadSnapshot(adapterId, signal),
      glossary: this.glossary,
      ...(options.catalogTtlMs !== undefined ? { ttlMs: options.catalogTtlMs } : {})
    });
    this.glossaryReady = this.glossary.load().then((status) => {
      try {
        this.glossary.watch();
      } catch {
        // Hot reload is best effort; explicit reload still works through load().
      }
      return status;
    });
  }

  public definitions(): ReadonlyArray<{
    name: DiscoveryToolName;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [
      {
        name: 'list_tables',
        description:
          'Lists tables and views from system catalogs only (no row is read), with estimated row counts and glossary titles. Supports schema filter, glob pattern and cursor pagination.',
        inputSchema: {
          type: 'object',
          required: ['adapterId'],
          properties: {
            adapterId: { type: 'string' },
            schema: { type: 'string', maxLength: 128 },
            namePattern: { type: 'string', maxLength: 128, description: 'glob with * and ?; never executed as SQL' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            cursor: { type: 'string' }
          }
        }
      },
      {
        name: 'describe_table',
        description:
          'Returns columns, native types, nullability, keys, indexes and declared foreign keys of a table from system catalogs, enriched with business glossary meanings and domain codes when documented.',
        inputSchema: {
          type: 'object',
          required: ['adapterId', 'table'],
          properties: {
            adapterId: { type: 'string' },
            schema: { type: 'string', maxLength: 128 },
            table: { type: 'string', maxLength: 257 }
          }
        }
      },
      {
        name: 'infer_table_relationships',
        description:
          'Infers probable relationships between tables that lack declared foreign keys using naming patterns, type compatibility and bounded aggregate sampling. Each result carries a confidence score and explanation.',
        inputSchema: {
          type: 'object',
          required: ['adapterId', 'tables'],
          properties: {
            adapterId: { type: 'string' },
            tables: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 257 } },
            minConfidence: { type: 'number', minimum: 0, maximum: 1, default: 0.7 },
            verifyStatistically: { type: 'boolean', default: true }
          }
        }
      },
      {
        name: 'search_glossary',
        description:
          'Searches the versioned business glossary (tables, columns, synonyms and domain codes) and returns the matching physical tables and columns.',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            adapterId: { type: 'string', description: 'optional; enables stale-reference warnings' },
            query: { type: 'string', minLength: 2, maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
          }
        }
      }
    ];
  }

  public handles(name: string): name is DiscoveryToolName {
    return (DISCOVERY_TOOL_NAMES as ReadonlyArray<string>).includes(name);
  }

  public async call(
    name: DiscoveryToolName,
    rawArgs: Record<string, unknown>,
    ctx: DiscoveryCallContext
  ): Promise<DiscoveryToolResult> {
    const started = performance.now();
    await this.glossaryReady;

    const action: DiscoveryAuditAction =
      name === 'infer_table_relationships'
        ? 'RELATIONSHIP_INFERENCE'
        : name === 'search_glossary'
          ? 'GLOSSARY_QUERY'
          : 'CATALOG_DISCOVERY';

    let target: string = name;
    let adapterId = typeof rawArgs['adapterId'] === 'string' ? rawArgs['adapterId'] : '';
    if (!adapterId && this.registry.listAdapterIds().length === 1) {
      adapterId = this.registry.listAdapterIds()[0]!;
      (rawArgs as Record<string, unknown>)['adapterId'] = adapterId;
    }
    let engine = 'unknown';
    let database = adapterId || 'default';
    let resultCount = 0;
    let failure: string | null = null;

    try {
      if (adapterId) {
        try {
          const adapter = this.registry.getAdapter(adapterId);
          engine = adapter.dialect;
          database = adapter.adapterId;
        } catch {
          // reported below by the handler
        }
      }

      switch (name) {
        case 'list_tables': {
          const args = listTablesArgs.parse(rawArgs);
          adapterId = args.adapterId;
          target = `${name} schema=${args.schema ?? '*'} pattern=${args.namePattern ?? '*'}`;
          const result = await this.catalog.listTables(args.adapterId, {
            ...(args.schema ? { schema: args.schema } : {}),
            ...(args.namePattern ? { namePattern: args.namePattern } : {}),
            ...(args.limit ? { limit: args.limit } : {}),
            ...(args.cursor ? { cursor: args.cursor } : {})
          });
          resultCount = result.tables.length;
          return this.ok(name, result);
        }
        case 'describe_table': {
          const args = describeTableArgs.parse(rawArgs);
          adapterId = args.adapterId;
          const ref = parseTableArgument(args.schema, args.table);
          target = `${name} ${ref.schema ? `${ref.schema}.` : ''}${ref.table}`;
          const detail = await this.catalog.describeTable(args.adapterId, ref);
          resultCount = detail.columns.length;
          return this.ok(name, detail);
        }
        case 'infer_table_relationships': {
          const args = inferArgs.parse(rawArgs);
          adapterId = args.adapterId;
          target = `${name} tables=${args.tables.length}`;
          const snapshot = await this.catalog.snapshot(args.adapterId);
          const tables = args.tables.map((raw) => {
            const parsed = parseQualifiedName(raw);
            const t = resolveTable(snapshot.catalog.tables, parsed);
            return { schema: t.schema, table: t.name };
          });
          const adapter = this.registry.getAdapter(args.adapterId);
          const relationships = await this.engine.infer({
            snapshot,
            adapter,
            request: {
              tables,
              ...(args.minConfidence !== undefined ? { minConfidence: args.minConfidence } : {}),
              ...(args.verifyStatistically !== undefined
                ? { verifyStatistically: args.verifyStatistically }
                : {})
            }
          });
          resultCount = relationships.length;
          return this.ok(name, {
            relationships,
            statisticalVerificationAvailable: isCatalogCapable(adapter),
            note: 'Inferred relationships are hypotheses; confidence HIGH requires statistical evidence.'
          });
        }
        case 'search_glossary': {
          const args = searchArgs.parse(rawArgs);
          target = `${name} chars=${args.query.length}`;
          const hits = this.glossary.search(args.query, args.limit ?? 10);
          resultCount = hits.length;
          let stale: ReadonlyArray<string> = [];
          if (args.adapterId) {
            const snapshot = await this.catalog.snapshot(args.adapterId);
            stale = this.glossary.staleReferences(
              snapshot.catalog.tables.map((t) => ({ schema: t.schema, table: t.name }))
            );
          }
          return this.ok(name, {
            hits,
            glossary: this.glossary.status(),
            warnings: stale
          });
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      if (err instanceof z.ZodError) {
        failure = `Invalid arguments: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
      }
      if (err instanceof z.ZodError || err instanceof TableResolutionError) {
        const candidates = err instanceof TableResolutionError ? err.candidates : [];
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: wrapUntrustedMetadata(name, { error: failure, candidates }, this.sanitizer)
            }
          ]
        };
      }
      throw err;
    } finally {
      await this.auditLogger.logEvent({
        correlationId: ctx.correlationId,
        requesterId: ctx.requesterId,
        timestamp: new Date().toISOString(),
        engine,
        database,
        evaluatedSql: `DISCOVERY ${auditTarget(target)}`,
        status: action,
        rejectionReason: failure,
        executionTimeMs: Number((performance.now() - started).toFixed(2)),
        rowCount: resultCount
      });
    }
  }

  private ok(tool: DiscoveryToolName, payload: unknown): DiscoveryToolResult {
    return {
      content: [{ type: 'text', text: wrapUntrustedMetadata(tool, payload, this.sanitizer) }]
    };
  }

  private async loadSnapshot(adapterId: string, signal?: AbortSignal): Promise<CatalogSnapshot> {
    const catalog = await this.registry.introspectAdapterSchema(adapterId, signal);
    const adapter = this.registry.getAdapter(adapterId);
    let extras = null;
    if (isCatalogCapable(adapter)) {
      try {
        extras = await adapter.getCatalogExtras(signal);
      } catch {
        extras = null; // degrade to baseline introspection
      }
    }
    return { catalog, extras };
  }
}
