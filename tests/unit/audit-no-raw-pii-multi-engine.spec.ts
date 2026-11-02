import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/core/audit/audit-logger.js';

describe('Audit Logger Multi-Engine Raw PII Protection (US5)', () => {
  let tempDir: string;
  let auditFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pii-test-'));
    auditFilePath = path.join(tempDir, 'audit.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('never logs raw NIT values in audit records or error traces', async () => {
    const logger = new AuditLogger({ logFilePath: auditFilePath });

    const rawNit = '1234567-4';

    // 1. Log query from MySQL with maskedColumns
    await logger.logEvent({
      correlationId: 'corr-mysql-1',
      requesterId: 'user-01',
      timestamp: new Date().toISOString(),
      engine: 'mysql',
      database: 'erp_mysql',
      evaluatedSql: 'SELECT empnit FROM empleados WHERE empnit = ?',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 14,
      rowCount: 1,
      maskedColumns: ['empnit']
    });

    // 2. Log rejected query from SQLite where rejection reason might leak raw input value
    await logger.logEvent({
      correlationId: 'corr-sqlite-2',
      requesterId: 'user-01',
      timestamp: new Date().toISOString(),
      engine: 'sqlite',
      database: 'local_sqlite',
      evaluatedSql: 'SELECT * FROM clientes WHERE nit = ?',
      status: 'REJECTED_BY_GUARD',
      rejectionReason: `Constraint violation on raw value ${rawNit}`,
      executionTimeMs: 3,
      rowCount: 0,
      maskedColumns: ['nit']
    });

    const fileContent = fs.readFileSync(auditFilePath, 'utf8');
    const lines = fileContent.trim().split('\n');

    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const record = JSON.parse(line);
      // Raw NIT must NEVER be present anywhere in the audit log line
      expect(line).not.toContain(rawNit);
      expect(record.maskedColumns).toBeDefined();
    }
  });
});
