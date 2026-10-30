import { createHash } from 'node:crypto';
import type { AuditLogEntry } from '../../contracts/audit.contract.js';
import { canonicalizeJson, extractCanonicalPayload } from './audit-canonicalizer.js';

export const GENESIS_PREVIOUS_HASH = '0'.repeat(64);

/**
 * Calculates the SHA-256 integrity hash for an audit log entry.
 * Hash formula: SHA-256(previousHash + canonicalJson)
 */
export function calculateEntryHash(
  entry: Omit<AuditLogEntry, 'entryHash'>
): string {
  const canonicalPayload = extractCanonicalPayload(entry);
  const canonicalJson = canonicalizeJson(canonicalPayload);
  return createHash('sha256')
    .update(entry.previousHash + canonicalJson, 'utf8')
    .digest('hex');
}

/**
 * Validates whether the given entry's entryHash matches the re-computed hash.
 */
export function verifyEntryHash(entry: AuditLogEntry): boolean {
  const expected = calculateEntryHash(entry);
  return expected === entry.entryHash;
}
