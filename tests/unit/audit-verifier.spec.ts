import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/core/audit/audit-logger.js';
import { AuditVerifier } from '../../src/core/audit/audit-verifier.js';

describe('AuditVerifier (User Story 3 - Inmutability and Tamper Detection)', () => {
  const testLogPath = resolve(process.cwd(), 'tests/fixtures/test-audit-verify.jsonl');
  const verifier = new AuditVerifier();

  beforeEach(() => {
    if (existsSync(testLogPath)) {
      rmSync(testLogPath, { force: true });
    }
  });

  afterEach(() => {
    if (existsSync(testLogPath)) {
      rmSync(testLogPath, { force: true });
    }
  });

  it('should verify an authentic append-only audit chain successfully', async () => {
    const logger = new AuditLogger({ logFilePath: testLogPath });
    for (let i = 1; i <= 5; i++) {
      await logger.logEvent({
        correlationId: `uuid-${i}`,
        requesterId: 'test-user',
        timestamp: new Date().toISOString(),
        engine: 'postgres',
        database: 'db_test',
        evaluatedSql: `SELECT * FROM table_${i}`,
        status: 'EXECUTED',
        rejectionReason: null,
        executionTimeMs: 10 + i,
        rowCount: i * 5
      });
    }

    const result = await verifier.verifyLogFile(testLogPath);
    expect(result.isValid).toBe(true);
    expect(result.totalEntries).toBe(5);
    expect(result.firstSequenceNumber).toBe(1);
    expect(result.lastSequenceNumber).toBe(5);
    expect(result.violatedEntry).toBeUndefined();
  });

  it('should detect when an entry is tampered (HASH_MISMATCH)', async () => {
    const logger = new AuditLogger({ logFilePath: testLogPath });
    const e1 = await logger.logEvent({
      correlationId: 'uuid-1',
      requesterId: 'test-user',
      timestamp: new Date().toISOString(),
      engine: 'postgres',
      database: 'db_test',
      evaluatedSql: 'SELECT * FROM table_1',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 10,
      rowCount: 5
    });

    const e2 = await logger.logEvent({
      correlationId: 'uuid-2',
      requesterId: 'test-user',
      timestamp: new Date().toISOString(),
      engine: 'postgres',
      database: 'db_test',
      evaluatedSql: 'SELECT * FROM table_2',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 12,
      rowCount: 10
    });

    // Tamper rowCount of entry 1 without changing entryHash
    const tamperedE1 = { ...e1, rowCount: 999 };
    writeFileSync(testLogPath, JSON.stringify(tamperedE1) + '\n' + JSON.stringify(e2) + '\n', 'utf8');

    const result = await verifier.verifyLogFile(testLogPath);
    expect(result.isValid).toBe(false);
    expect(result.violatedEntry?.reason).toBe('HASH_MISMATCH');
    expect(result.violatedEntry?.lineNumber).toBe(1);
    expect(result.violatedEntry?.sequenceNumber).toBe(1);
  });

  it('should detect when an intermediate line is deleted (SEQUENCE_GAP)', async () => {
    const logger = new AuditLogger({ logFilePath: testLogPath });
    const e1 = await logger.logEvent({
      correlationId: 'uuid-1',
      requesterId: 'test-user',
      timestamp: new Date().toISOString(),
      engine: 'postgres',
      database: 'db_test',
      evaluatedSql: 'SELECT 1',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 5,
      rowCount: 1
    });

    await logger.logEvent({
      correlationId: 'uuid-2',
      requesterId: 'test-user',
      timestamp: new Date().toISOString(),
      engine: 'postgres',
      database: 'db_test',
      evaluatedSql: 'SELECT 2',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 6,
      rowCount: 1
    });

    const e3 = await logger.logEvent({
      correlationId: 'uuid-3',
      requesterId: 'test-user',
      timestamp: new Date().toISOString(),
      engine: 'postgres',
      database: 'db_test',
      evaluatedSql: 'SELECT 3',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 7,
      rowCount: 1
    });

    // Write only e1 and e3 (deleting e2)
    writeFileSync(testLogPath, JSON.stringify(e1) + '\n' + JSON.stringify(e3) + '\n', 'utf8');

    const result = await verifier.verifyLogFile(testLogPath);
    expect(result.isValid).toBe(false);
    expect(result.violatedEntry?.reason).toBe('SEQUENCE_GAP');
    expect(result.violatedEntry?.lineNumber).toBe(2);
    expect(result.violatedEntry?.sequenceNumber).toBe(3);
  });
});
