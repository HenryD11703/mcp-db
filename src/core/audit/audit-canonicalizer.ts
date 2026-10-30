import type { AuditLogEntry, CanonicalAuditPayload } from '../../contracts/audit.contract.js';

/**
 * Extracts and canonicalizes the payload of an audit entry for deterministic hashing.
 * Sorts all object keys lexicographically and excludes previousHash and entryHash.
 */
export function extractCanonicalPayload(
  entry: Omit<AuditLogEntry, 'entryHash'> | AuditLogEntry
): CanonicalAuditPayload {
  return {
    correlationId: entry.correlationId,
    database: entry.database,
    engine: entry.engine,
    evaluatedSql: entry.evaluatedSql,
    executionTimeMs: entry.executionTimeMs,
    rejectionReason: entry.rejectionReason,
    requesterId: entry.requesterId,
    rowCount: entry.rowCount,
    sequenceNumber: entry.sequenceNumber,
    status: entry.status,
    timestamp: entry.timestamp
  };
}

/**
 * Serializes an object into canonical JSON with lexicographically sorted keys.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((key) => {
    return JSON.stringify(key) + ':' + canonicalizeJson(obj[key]);
  });

  return '{' + pairs.join(',') + '}';
}
