import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PendingApprovalTicket, ApprovedQueryResult } from '../../../src/contracts/cost-limits.contract.js';
import { PendingApprovalStore } from '../../../src/core/limits/pending-approval-store.js';

describe('PendingApprovalStore (User Story 3 - P2)', () => {
  const testStorePath = '.db-mcp/test-pending-approvals.json';
  let store: PendingApprovalStore;

  const sampleTicket: PendingApprovalTicket = {
    approvalId: 'appr_12345678-1234-1234-1234-123456789abc',
    correlationId: 'corr-100',
    requesterId: 'client-user-1',
    engine: 'postgres',
    database: 'finanzas',
    sql: 'SELECT * FROM transacciones WHERE monto > 10000',
    params: [],
    riskProfile: {
      severity: 'MEDIUM_CAUTION',
      estimatedCost: 12000,
      estimatedRows: 25000,
      hasFullScan: false,
      scannedTables: [],
      hasCartesianJoin: false,
      isVerifiable: true,
      warnings: ['Filas estimadas superan umbral de precaución']
    },
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  };

  beforeEach(() => {
    const dir = dirname(testStorePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (existsSync(testStorePath)) {
      rmSync(testStorePath);
    }
    store = new PendingApprovalStore({ storeFilePath: testStorePath });
  });

  afterEach(() => {
    if (existsSync(testStorePath)) {
      rmSync(testStorePath);
    }
  });

  it('saves and retrieves a pending ticket by approvalId', async () => {
    await store.saveTicket(sampleTicket);

    const retrieved = await store.getTicket(sampleTicket.approvalId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.approvalId).toBe(sampleTicket.approvalId);
    expect(retrieved?.status).toBe('PENDING');
    expect(retrieved?.sql).toBe(sampleTicket.sql);
  });

  it('persists tickets across store instances by reloading from file', async () => {
    await store.saveTicket(sampleTicket);

    const newStoreInstance = new PendingApprovalStore({ storeFilePath: testStorePath });
    const retrieved = await newStoreInstance.getTicket(sampleTicket.approvalId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.approvalId).toBe(sampleTicket.approvalId);
  });

  it('resolves a ticket to APPROVED with operator metadata', async () => {
    await store.saveTicket(sampleTicket);

    const resolved = await store.resolveTicket(
      sampleTicket.approvalId,
      'APPROVED',
      'operador_seguridad',
      'Aprobado para informe contable'
    );

    expect(resolved.status).toBe('APPROVED');
    expect(resolved.resolvedBy).toBe('operador_seguridad');
    expect(resolved.resolutionReason).toBe('Aprobado para informe contable');
    expect(resolved.resolvedAt).toBeDefined();

    const pendingList = await store.listPendingTickets();
    expect(pendingList).toHaveLength(0);
  });

  it('saves and retrieves approved query results', async () => {
    const result: ApprovedQueryResult = {
      approvalId: sampleTicket.approvalId,
      columns: [{ name: 'id', dataType: 'int' }],
      rows: [{ id: 101 }, { id: 102 }],
      rowCount: 2,
      truncated: false,
      executedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };

    await store.saveApprovedResult(result);

    const retrieved = await store.getApprovedResult(sampleTicket.approvalId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.rowCount).toBe(2);
    expect(retrieved?.rows).toEqual(result.rows);
  });

  it('purges expired tickets and results based on TTL', async () => {
    const expiredTicket: PendingApprovalTicket = {
      ...sampleTicket,
      approvalId: 'appr_expired_1',
      expiresAt: new Date(Date.now() - 1000).toISOString() // already expired
    };

    await store.saveTicket(expiredTicket);
    await store.saveTicket(sampleTicket); // active

    const purgedCount = await store.purgeExpiredTickets();
    expect(purgedCount).toBe(1);

    const pendingList = await store.listPendingTickets();
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]?.approvalId).toBe(sampleTicket.approvalId);
  });
});
