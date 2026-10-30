import { describe, expect, it } from 'vitest';
import type { AuditLogEntry } from '../../src/contracts/audit.contract.js';
import { canonicalizeJson, extractCanonicalPayload } from '../../src/core/audit/audit-canonicalizer.js';
import {
  calculateEntryHash,
  GENESIS_PREVIOUS_HASH,
  verifyEntryHash
} from '../../src/core/audit/audit-hasher.js';

describe('Audit Canonicalizer & Hasher (Foundational)', () => {
  it('should deterministically sort object keys regardless of original insertion order', () => {
    const objA = { b: 2, a: 1, c: { y: 'bar', x: 'foo' } };
    const objB = { c: { x: 'foo', y: 'bar' }, a: 1, b: 2 };

    expect(canonicalizeJson(objA)).toBe(canonicalizeJson(objB));
    expect(canonicalizeJson(objA)).toBe('{"a":1,"b":2,"c":{"x":"foo","y":"bar"}}');
  });

  it('should calculate identical hash for identical canonical payload', () => {
    const rawEntry: Omit<AuditLogEntry, 'entryHash'> = {
      sequenceNumber: 1,
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      requesterId: 'user-42',
      timestamp: '2026-10-30T10:00:00.000Z',
      engine: 'postgres',
      database: 'production',
      evaluatedSql: 'SELECT * FROM users WHERE id = [REDACTED_NUM]',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 14.5,
      rowCount: 1,
      previousHash: GENESIS_PREVIOUS_HASH
    };

    const hash1 = calculateEntryHash(rawEntry);
    const hash2 = calculateEntryHash(rawEntry);

    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);

    const fullEntry: AuditLogEntry = {
      ...rawEntry,
      entryHash: hash1
    };

    expect(verifyEntryHash(fullEntry)).toBe(true);
  });

  it('should detect any tampering in the payload', () => {
    const rawEntry: Omit<AuditLogEntry, 'entryHash'> = {
      sequenceNumber: 1,
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      requesterId: 'user-42',
      timestamp: '2026-10-30T10:00:00.000Z',
      engine: 'postgres',
      database: 'production',
      evaluatedSql: 'SELECT * FROM users WHERE id = [REDACTED_NUM]',
      status: 'EXECUTED',
      rejectionReason: null,
      executionTimeMs: 14.5,
      rowCount: 1,
      previousHash: GENESIS_PREVIOUS_HASH
    };

    const legitimateHash = calculateEntryHash(rawEntry);
    const tamperedEntry: AuditLogEntry = {
      ...rawEntry,
      rowCount: 100, // Tampered count!
      entryHash: legitimateHash
    };

    expect(verifyEntryHash(tamperedEntry)).toBe(false);
  });
});
