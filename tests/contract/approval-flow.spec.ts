import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  SchemaCatalog
} from '../../src/contracts/database-adapter.js';
import {
  bootstrapAdapters,
  createDatabaseMcpServer
} from '../../src/index.js';
import { PendingApprovalStore } from '../../src/core/limits/pending-approval-store.js';
import { handleCli } from '../../src/bin/db-mcp.js';
import { rmSync, existsSync } from 'node:fs';

function createApprovalTestAdapter(options: {
  readonly adapterId: string;
  readonly planRisk: NormalizedRiskProfile;
  readonly executeSpy?: () => void;
}): DatabaseAdapter {
  return {
    adapterId: options.adapterId,
    dialect: 'postgres',
    async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
      return {
        isReadOnly: true,
        principalName: 'mcp_ro',
        sessionReadOnlyEnforced: true,
        violations: [],
        checkedAt: new Date().toISOString()
      };
    },
    async analyzeQueryPlan(_query: ParameterizedQuery): Promise<NormalizedRiskProfile> {
      return options.planRisk;
    },
    async executeQuery(_query: ParameterizedQuery): Promise<QueryExecutionResult> {
      options.executeSpy?.();
      return {
        columns: [
          { name: 'id', dataType: 'int4' },
          { name: 'descripcion', dataType: 'varchar' }
        ],
        rows: [
          { id: 1, descripcion: 'Transaccion autorizada 1' },
          { id: 2, descripcion: 'Transaccion autorizada 2' }
        ],
        rowCount: 2,
        durationMs: 10
      };
    },
    async introspectSchema(): Promise<SchemaCatalog> {
      return {
        databaseName: 'finanzas',
        dialect: 'postgres',
        tables: [],
        foreignKeys: [],
        inspectedAt: new Date().toISOString()
      };
    },
    async close(): Promise<void> {}
  };
}

describe('Human-in-the-loop Approval & Tool Contracts (User Story 3 - P2)', () => {
  const storeFilePath = '.db-mcp/test-approval-flow.json';

  it('guarantees AI isolation: exposes get_query_result but excludes any approve tool (SC-004)', async () => {
    const adapter = createApprovalTestAdapter({
      adapterId: 'pg-test',
      planRisk: {
        hasFullScan: false,
        hasUnconditionalJoin: false,
        estimatedRows: 50,
        estimatedCost: 10
      }
    });

    const registry = await bootstrapAdapters([adapter]);
    const server = createDatabaseMcpServer(registry);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const toolsList = await client.listTools();
    const toolNames = toolsList.tools.map((t) => t.name);

    expect(toolNames).toContain('query_database');
    expect(toolNames).toContain('get_query_result');
    expect(toolNames).not.toContain('approve_query');
    expect(toolNames).not.toContain('reject_query');
    expect(toolNames).not.toContain('db_approve');
  });

  it('routes caution queries to PENDING_APPROVAL immediately (<500ms) without running query (SC-003)', async () => {
    if (existsSync(storeFilePath)) {
      rmSync(storeFilePath);
    }
    const store = new PendingApprovalStore({ storeFilePath });

    const execSpy = vi.fn();
    const adapter = createApprovalTestAdapter({
      adapterId: 'pg-caution',
      planRisk: {
        hasFullScan: false,
        hasUnconditionalJoin: false,
        estimatedRows: 25000, // exceeds caution threshold 10,000
        estimatedCost: 8000
      },
      executeSpy: execSpy
    });

    const registry = await bootstrapAdapters([adapter]);
    const server = createDatabaseMcpServer(registry, { approvalStore: store });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const start = performance.now();
    const response = await client.callTool({
      name: 'query_database',
      arguments: {
        adapterId: 'pg-caution',
        sql: 'SELECT * FROM transacciones WHERE monto > 1000'
      }
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500); // < 500ms
    expect(execSpy).not.toHaveBeenCalled(); // Query was NOT executed

    const text = (response.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('PENDING_APPROVAL');
    expect(text).toContain('appr_');

    // Parse approvalId from response
    const match = text.match(/appr_[a-f0-9\-]+/i);
    expect(match).not.toBeNull();
    const approvalId = match![0];

    // Check store state
    const ticket = await store.getTicket(approvalId);
    expect(ticket).not.toBeNull();
    expect(ticket?.status).toBe('PENDING');

    // Operator approves via CLI
    process.env['PENDING_APPROVAL_STORE_PATH'] = storeFilePath;
    const cliResult = await handleCli(['approve', approvalId, '--reason', 'Autorizado por jefe de seguridad']);
    expect(cliResult).toBe(0);

    // Verify resolved status in store
    const updatedTicket = await store.getTicket(approvalId);
    expect(updatedTicket?.status).toBe('APPROVED');

    // Client passively retrieves the approved query result via get_query_result tool
    const retrieveResponse = await client.callTool({
      name: 'get_query_result',
      arguments: {
        approvalId
      }
    });

    const resultText = (retrieveResponse.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(resultText).toContain('Transaccion autorizada');

    if (existsSync(storeFilePath)) {
      rmSync(storeFilePath);
    }
  });
});
