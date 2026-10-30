import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditLogEntry, AuditQueryOutcome } from '../../src/contracts/audit.contract.js';
import { AuditLogger } from '../../src/core/audit/audit-logger.js';
import { GENESIS_PREVIOUS_HASH, verifyEntryHash } from '../../src/core/audit/audit-hasher.js';
import { AuditPersistenceError } from '../../src/core/errors.js';

describe('AuditLogger (User Story 1 - Structured Lifecycle Logging)', () => {
  const testLogPath = resolve(process.cwd(), 'tests/fixtures/test-audit-us1.jsonl');

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

  it('should capture all 5 outcomes with mandatory fields and sequential hashing', async () => {
    const logger = new AuditLogger({ logFilePath: testLogPath });

    const outcomes: Array<{
      status: AuditQueryOutcome;
      rejectionReason: string | null;
      rowCount: number;
    }> = [
      { status: 'EXECUTED', rejectionReason: null, rowCount: 42 },
      { status: 'REJECTED_BY_GUARD', rejectionReason: 'STACKED_QUERIES_DETECTED', rowCount: 0 },
      { status: 'BLOCKED_BY_COST', rejectionReason: 'ESTIMATED_COST_EXCEEDED (12000 > 10000)', rowCount: 0 },
      { status: 'PENDING_APPROVAL', rejectionReason: 'HIGH_RISK_POLICY_REQUIRES_HUMAN_CONFIRMATION', rowCount: 0 },
      { status: 'CANCELLED_BY_TIMEOUT', rejectionReason: 'EXECUTION_TIMEOUT_EXCEEDED (30000ms)', rowCount: 0 }
    ];

    const entries: AuditLogEntry[] = [];
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i]!;
      const entry = await logger.logEvent({
        correlationId: `corr-${i + 1}`,
        requesterId: `session-${i + 1}`,
        timestamp: new Date().toISOString(),
        engine: 'postgres',
        database: 'demo_db',
        evaluatedSql: 'SELECT * FROM test',
        status: outcome.status,
        rejectionReason: outcome.rejectionReason,
        executionTimeMs: 12.3 + i,
        rowCount: outcome.rowCount
      });
      entries.push(entry);
    }

    expect(entries).toHaveLength(5);
    expect(logger.getCurrentSequenceNumber()).toBe(5);

    // Verify first entry uses genesis hash
    const firstEntry = entries[0]!;
    expect(firstEntry.previousHash).toBe(GENESIS_PREVIOUS_HASH);
    expect(firstEntry.sequenceNumber).toBe(1);
    expect(verifyEntryHash(firstEntry)).toBe(true);

    // Verify chain linking
    for (let i = 1; i < entries.length; i++) {
      const current = entries[i]!;
      const previous = entries[i - 1]!;
      expect(current.sequenceNumber).toBe(i + 1);
      expect(current.previousHash).toBe(previous.entryHash);
      expect(verifyEntryHash(current)).toBe(true);
    }

    // Verify file content on disk
    const content = readFileSync(testLogPath, 'utf8').trim().split('\n');
    expect(content).toHaveLength(5);
    const line1 = content[0]!;
    const line2 = content[1]!;
    const parsedLine1 = JSON.parse(line1);
    expect(parsedLine1.status).toBe('EXECUTED');
    expect(parsedLine1.rowCount).toBe(42);
    expect(parsedLine1.rejectionReason).toBeNull();

    const parsedLine2 = JSON.parse(line2);
    expect(parsedLine2.status).toBe('REJECTED_BY_GUARD');
    expect(parsedLine2.rowCount).toBe(0);
    expect(parsedLine2.rejectionReason).toBe('STACKED_QUERIES_DETECTED');
  });

  it('should enforce fail-closed policy when file write fails', async () => {
    // Pointing to an invalid directory path on Windows that cannot be written
    const invalidPath = 'Z:/non-existent-drive-path/cannot-write.jsonl';
    
    // In failClosed mode, constructing or writing to an invalid path fails with AuditPersistenceError
    expect(() => {
      new AuditLogger({
        logFilePath: invalidPath,
        failClosed: true
      });
    }).toThrow(AuditPersistenceError);
  });
});
