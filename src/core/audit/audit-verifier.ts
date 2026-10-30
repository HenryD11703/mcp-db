import { existsSync, readFileSync } from 'node:fs';
import type {
  AuditLogEntry,
  AuditVerificationResult,
  IAuditVerifier
} from '../../contracts/audit.contract.js';
import { calculateEntryHash, GENESIS_PREVIOUS_HASH } from './audit-hasher.js';

export class AuditVerifier implements IAuditVerifier {
  public async verifyLogFile(filePath: string): Promise<AuditVerificationResult> {
    if (!existsSync(filePath)) {
      return {
        isValid: false,
        totalEntries: 0,
        firstSequenceNumber: 0,
        lastSequenceNumber: 0,
        violatedEntry: {
          sequenceNumber: 0,
          correlationId: '',
          expectedHash: '',
          actualHash: '',
          reason: 'INVALID_JSON',
          lineNumber: 0,
          rawLine: `File does not exist: ${filePath}`
        }
      };
    }

    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    let totalEntries = 0;
    let firstSequenceNumber = 0;
    let lastSequenceNumber = 0;
    let previousHash = GENESIS_PREVIOUS_HASH;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) {
        continue;
      }
      const rawLine = line.trim();
      if (rawLine.length === 0) {
        continue;
      }

      const lineNumber = index + 1;
      let parsed: AuditLogEntry;

      try {
        parsed = JSON.parse(rawLine) as AuditLogEntry;
      } catch {
        return {
          isValid: false,
          totalEntries,
          firstSequenceNumber,
          lastSequenceNumber,
          violatedEntry: {
            sequenceNumber: totalEntries + 1,
            correlationId: '',
            expectedHash: '',
            actualHash: '',
            reason: 'INVALID_JSON',
            lineNumber,
            rawLine
          }
        };
      }

      totalEntries++;
      if (totalEntries === 1) {
        firstSequenceNumber = parsed.sequenceNumber;
      }

      // 1. Check sequence monotonicity
      if (totalEntries > 1 && parsed.sequenceNumber !== lastSequenceNumber + 1) {
        return {
          isValid: false,
          totalEntries,
          firstSequenceNumber,
          lastSequenceNumber,
          violatedEntry: {
            sequenceNumber: parsed.sequenceNumber,
            correlationId: parsed.correlationId,
            expectedHash: '',
            actualHash: '',
            reason: 'SEQUENCE_GAP',
            lineNumber,
            rawLine
          }
        };
      }
      lastSequenceNumber = parsed.sequenceNumber;

      // 2. Check previousHash linking
      if (totalEntries === 1 && parsed.previousHash !== GENESIS_PREVIOUS_HASH) {
        // If it's a rotated segment, it may inherit from a prior segment.
        // But within an isolated file starting with genesis, it must be GENESIS_PREVIOUS_HASH.
        // We set previousHash to whatever the first record has to verify internal chain
        previousHash = parsed.previousHash;
      } else if (totalEntries > 1 && parsed.previousHash !== previousHash) {
        return {
          isValid: false,
          totalEntries,
          firstSequenceNumber,
          lastSequenceNumber,
          violatedEntry: {
            sequenceNumber: parsed.sequenceNumber,
            correlationId: parsed.correlationId,
            expectedHash: previousHash,
            actualHash: parsed.previousHash,
            reason: 'PREVIOUS_HASH_MISMATCH',
            lineNumber,
            rawLine
          }
        };
      }

      // 3. Check entryHash recomputation
      const candidate: Omit<AuditLogEntry, 'entryHash'> = {
        correlationId: parsed.correlationId,
        database: parsed.database,
        engine: parsed.engine,
        evaluatedSql: parsed.evaluatedSql,
        executionTimeMs: parsed.executionTimeMs,
        previousHash: parsed.previousHash,
        rejectionReason: parsed.rejectionReason,
        requesterId: parsed.requesterId,
        rowCount: parsed.rowCount,
        sequenceNumber: parsed.sequenceNumber,
        status: parsed.status,
        timestamp: parsed.timestamp
      };

      const computedHash = calculateEntryHash(candidate);
      if (computedHash !== parsed.entryHash) {
        return {
          isValid: false,
          totalEntries,
          firstSequenceNumber,
          lastSequenceNumber,
          violatedEntry: {
            sequenceNumber: parsed.sequenceNumber,
            correlationId: parsed.correlationId,
            expectedHash: computedHash,
            actualHash: parsed.entryHash,
            reason: 'HASH_MISMATCH',
            lineNumber,
            rawLine
          }
        };
      }

      previousHash = parsed.entryHash;
    }

    return {
      isValid: true,
      totalEntries,
      firstSequenceNumber,
      lastSequenceNumber
    };
  }
}
