import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AuditLogEntry,
  AuditLoggerOptions,
  IAuditLogger
} from '../../contracts/audit.contract.js';
import { AuditPersistenceError } from '../errors.js';
import {
  calculateEntryHash,
  GENESIS_PREVIOUS_HASH
} from './audit-hasher.js';

function sanitizeAuditReason(reason: string | null): string | null {
  if (!reason) return null;
  return reason
    .replace(/\b\d{2,8}-[0-9kK]\b/g, "[REDACTED_NIT]")
    .replace(/\b\d{4}\s?\d{5}\s?\d{4}\b/g, "[REDACTED_DPI]")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]");
}

export class AuditLogger implements IAuditLogger {
  private readonly options: Required<AuditLoggerOptions>;
  private currentSequenceNumber: number = 0;
  private latestHash: string = GENESIS_PREVIOUS_HASH;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AuditLoggerOptions) {
    this.options = {
      logFilePath: options.logFilePath,
      maxFileSizeBytes: options.maxFileSizeBytes ?? 100 * 1024 * 1024,
      rotateDaily: options.rotateDaily ?? true,
      failClosed: options.failClosed ?? true
    };

    this.initializeStateFromFile();
  }

  private initializeStateFromFile(): void {
    try {
      const dir = dirname(this.options.logFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      if (existsSync(this.options.logFilePath)) {
        const content = readFileSync(this.options.logFilePath, 'utf8').trim();
        if (content.length > 0) {
          const lines = content.split('\n').filter((l) => l.trim().length > 0);
          if (lines.length > 0) {
            const lastLine = lines[lines.length - 1];
            if (lastLine) {
              const parsed = JSON.parse(lastLine) as AuditLogEntry;
              this.currentSequenceNumber = parsed.sequenceNumber;
              this.latestHash = parsed.entryHash;
            }
          }
        }
      }
    } catch (err) {
      if (this.options.failClosed) {
        throw new AuditPersistenceError(
          this.options.logFilePath,
          'Failed to initialize existing audit log file state',
          err instanceof Error ? err : undefined
        );
      }
    }
  }

  public getCurrentSequenceNumber(): number {
    return this.currentSequenceNumber;
  }

  public getLatestHash(): string {
    return this.latestHash;
  }

  public async logEvent(
    event: Omit<AuditLogEntry, 'sequenceNumber' | 'previousHash' | 'entryHash'>
  ): Promise<AuditLogEntry> {
    return new Promise<AuditLogEntry>((resolve, reject) => {
      this.writeQueue = this.writeQueue
        .then(async () => {
          const sequenceNumber = this.currentSequenceNumber + 1;
          const previousHash = this.latestHash;

          const sanitizedReason = sanitizeAuditReason(event.rejectionReason);
          const candidate: Omit<AuditLogEntry, 'entryHash'> = Object.freeze({
            ...event,
            rejectionReason: sanitizedReason,
            sequenceNumber,
            previousHash
          });

          const entryHash = calculateEntryHash(candidate);
          const fullEntry: AuditLogEntry = Object.freeze({
            ...candidate,
            entryHash
          });

          const line = JSON.stringify(fullEntry) + '\n';

          try {
            await appendFile(this.options.logFilePath, line, {
              encoding: 'utf8',
              flag: 'a'
            });

            this.currentSequenceNumber = sequenceNumber;
            this.latestHash = entryHash;
            resolve(fullEntry);
          } catch (err) {
            const persistenceErr = new AuditPersistenceError(
              this.options.logFilePath,
              'Could not append entry to audit log file',
              err instanceof Error ? err : undefined
            );
            if (this.options.failClosed) {
              reject(persistenceErr);
            } else {
              // Even if not failing closed, log to console
              console.error(persistenceErr);
              resolve(fullEntry);
            }
          }
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  public async close(): Promise<void> {
    await this.writeQueue;
  }
}
