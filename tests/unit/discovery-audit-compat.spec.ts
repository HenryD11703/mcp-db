import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogger } from '../../src/core/audit/audit-logger.js';
import { AuditVerifier } from '../../src/core/audit/audit-verifier.js';
import type { AuditQueryOutcome } from '../../src/contracts/audit.contract.js';

describe('Discovery Audit Compatibility (T007)', () => {
  const testLogPath = resolve(process.cwd(), 'tests/fixtures/test-discovery-audit-compat.jsonl');
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

  it('maintains continuous tamper-proof hash chain across mixed query and discovery events', async () => {
    const logger = new AuditLogger({ logFilePath: testLogPath });
    const sequence: ReadonlyArray<{ sql: string; status: AuditQueryOutcome; count: number }> = [
      { sql: 'SELECT * FROM clientes', status: 'EXECUTED', count: 10 },
      { sql: 'DISCOVERY list_tables schema=public pattern=*', status: 'CATALOG_DISCOVERY', count: 25 },
      { sql: 'DISCOVERY describe_table public.clientes', status: 'CATALOG_DISCOVERY', count: 5 },
      { sql: 'DISCOVERY infer_table_relationships tables=2', status: 'RELATIONSHIP_INFERENCE', count: 1 },
      { sql: 'DISCOVERY search_glossary chars=8', status: 'GLOSSARY_QUERY', count: 3 },
      { sql: 'SELECT * FROM transacciones', status: 'BLOCKED_BY_COST', count: 0 }
    ];

    for (let i = 0; i < sequence.length; i++) {
      const item = sequence[i]!;
      await logger.logEvent({
        correlationId: `corr-${i + 1}`,
        requesterId: 'analyst-1',
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        engine: 'postgres',
        database: 'legacy_db',
        evaluatedSql: item.sql,
        status: item.status,
        rejectionReason: item.status === 'BLOCKED_BY_COST' ? 'Cost exceeded' : null,
        executionTimeMs: 5 + i * 2,
        rowCount: item.count
      });
    }

    const verification = await verifier.verifyLogFile(testLogPath);
    expect(verification.isValid).toBe(true);
    expect(verification.totalEntries).toBe(6);
    expect(verification.firstSequenceNumber).toBe(1);
    expect(verification.lastSequenceNumber).toBe(6);
    expect(verification.violatedEntry).toBeUndefined();
  });
});
