import { z } from 'zod';
import type {
  FederatedQueryOptions,
  IFederatedQueryOrchestrator
} from '../../contracts/federated-query.contract.js';

export const FederatedQueryArgsSchema = z.object({
  sourceAdapterId: z.string().min(1).max(128),
  sourceSql: z.string().min(1),
  sourceKeyColumn: z.string().min(1).max(128),
  targetAdapterId: z.string().min(1).max(128),
  targetSqlTemplate: z.string().min(1),
  targetJoinColumn: z.string().min(1).max(128),
  joinType: z.enum(['LEFT', 'INNER']).optional(),
  maxKeys: z.number().int().min(1).max(1000).optional(),
  overflowAction: z.enum(['truncate', 'fail']).optional(),
  requesterId: z.string().optional()
});

export type FederatedQueryArgs = z.infer<typeof FederatedQueryArgsSchema>;

export interface FederatedToolResult {
  [key: string]: unknown;
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}

export interface FederatedCallContext {
  readonly requesterId?: string;
  readonly correlationId?: string;
}

export class FederatedTools {
  private readonly orchestrator: IFederatedQueryOrchestrator;

  constructor(orchestrator: IFederatedQueryOrchestrator) {
    this.orchestrator = orchestrator;
  }

  public definitions(): ReadonlyArray<{
    name: 'execute_federated_query';
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return [
      {
        name: 'execute_federated_query',
        description:
          'Executes a secure cross-database federated query in memory without linked servers. Queries source DB (BD A), extracts keys, injects them as typed parameters into target DB (BD B) template via IN (:keys), joins results in memory (LEFT/INNER), and pseudonymizes sensitive join keys (pseudo_<16_hex>) before serialization.',
        inputSchema: {
          type: 'object',
          required: [
            'sourceAdapterId',
            'sourceSql',
            'sourceKeyColumn',
            'targetAdapterId',
            'targetSqlTemplate',
            'targetJoinColumn'
          ],
          properties: {
            sourceAdapterId: {
              type: 'string',
              description: 'Registered adapter ID for source database (BD A).'
            },
            sourceSql: {
              type: 'string',
              description: 'Read-only SELECT query executed against source database.'
            },
            sourceKeyColumn: {
              type: 'string',
              description: 'Column name in BD A results to extract as filtering keys.'
            },
            targetAdapterId: {
              type: 'string',
              description: 'Registered adapter ID for target database (BD B).'
            },
            targetSqlTemplate: {
              type: 'string',
              description:
                'SQL query template for BD B containing explicit placeholder "WHERE column IN (:keys)".'
            },
            targetJoinColumn: {
              type: 'string',
              description: 'Column name in BD B to join with source keys.'
            },
            joinType: {
              type: 'string',
              enum: ['LEFT', 'INNER'],
              default: 'LEFT',
              description: 'Memory join type (default LEFT).'
            },
            maxKeys: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 500,
              description: 'Strict upper bound of keys extracted and injected into BD B (default 500).'
            },
            overflowAction: {
              type: 'string',
              enum: ['truncate', 'fail'],
              default: 'truncate',
              description:
                'Action when extracted keys exceed maxKeys: "truncate" (default, runs top keys with warning) or "fail" (aborts with error).'
            }
          }
        }
      }
    ];
  }

  public handles(toolName: string): boolean {
    return toolName === 'execute_federated_query';
  }

  public async call(
    toolName: string,
    rawArgs: unknown,
    context?: FederatedCallContext
  ): Promise<FederatedToolResult> {
    if (toolName !== 'execute_federated_query') {
      throw new Error(`FederatedTools does not handle tool "${toolName}".`);
    }

    const parsed = FederatedQueryArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Invalid arguments for execute_federated_query: ${parsed.error.message}`
          }
        ]
      };
    }

    const options: FederatedQueryOptions = {
      ...parsed.data,
      requesterId: parsed.data.requesterId ?? context?.requesterId
    };

    try {
      const result = await this.orchestrator.executeFederatedQuery(options);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message }, null, 2)
          }
        ]
      };
    }
  }
}
