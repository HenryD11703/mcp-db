import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import type {
  ApprovedQueryResult,
  IPendingApprovalStore,
  PendingApprovalTicket
} from '../../contracts/cost-limits.contract.js';

export interface PendingApprovalStoreOptions {
  readonly storeFilePath?: string;
}

interface StoredPayload {
  readonly version: string;
  readonly tickets: PendingApprovalTicket[];
  readonly approvedResults: ApprovedQueryResult[];
}

export class PendingApprovalStore implements IPendingApprovalStore {
  private readonly storeFilePath: string;
  private readonly fallbackPaths: string[] = [];
  private readonly tickets = new Map<string, PendingApprovalTicket>();
  private readonly approvedResults = new Map<string, ApprovedQueryResult>();

  constructor(options: PendingApprovalStoreOptions = {}) {
    if (options.storeFilePath) {
      this.storeFilePath = options.storeFilePath;
    } else {
      const explicitEnv =
        process.env['PENDING_APPROVAL_STORE_PATH'] ||
        process.env['APPROVAL_STORE_PATH'];

      if (explicitEnv) {
        this.storeFilePath = explicitEnv;
      } else {
        // Global canonical path in user's home directory: ~/.db-mcp/pending_approvals.json
        this.storeFilePath = join(homedir(), '.db-mcp', 'pending_approvals.json');
        this.fallbackPaths = [
          resolve(process.cwd(), '.db-mcp', 'pending_approvals.json'),
          join(homedir(), 'Documents', 'test-mcp', '.db-mcp', 'pending_approvals.json')
        ];
      }
    }

    this.initializeFromFile();
  }

  public async saveTicket(ticket: PendingApprovalTicket): Promise<void> {
    this.tickets.set(ticket.approvalId, ticket);
    this.atomicWrite();
  }

  public async getTicket(approvalId: string): Promise<PendingApprovalTicket | null> {
    this.initializeFromFile();
    const cleanId = approvalId.replace(/['"]/g, '').trim().toLowerCase();

    // 1. Exact match
    let ticket = this.tickets.get(approvalId) || this.tickets.get(cleanId);

    // 2. Prefix or substring match
    if (!ticket) {
      for (const [id, t] of this.tickets.entries()) {
        const lowerId = id.toLowerCase();
        if (lowerId === cleanId || lowerId.startsWith(cleanId) || lowerId.includes(cleanId)) {
          ticket = t;
          break;
        }
      }
    }

    if (!ticket) {
      return null;
    }

    if (ticket.status === 'PENDING' && new Date(ticket.expiresAt).getTime() <= Date.now()) {
      const expiredTicket: PendingApprovalTicket = {
        ...ticket,
        status: 'EXPIRED'
      };
      this.tickets.set(ticket.approvalId, expiredTicket);
      this.atomicWrite();
      return expiredTicket;
    }

    return ticket;
  }

  public async listPendingTickets(): Promise<ReadonlyArray<PendingApprovalTicket>> {
    this.initializeFromFile();
    const now = Date.now();
    const result: PendingApprovalTicket[] = [];

    for (const ticket of this.tickets.values()) {
      if (ticket.status === 'PENDING') {
        if (new Date(ticket.expiresAt).getTime() <= now) {
          this.tickets.set(ticket.approvalId, { ...ticket, status: 'EXPIRED' });
        } else {
          result.push(ticket);
        }
      }
    }

    return result;
  }

  public async resolveTicket(
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
    operatorIdentity: string,
    reason?: string
  ): Promise<PendingApprovalTicket> {
    const ticket = await this.getTicket(approvalId);
    if (!ticket) {
      throw new Error(`Ticket with approvalId "${approvalId}" does not exist.`);
    }

    if (ticket.status !== 'PENDING') {
      throw new Error(`Ticket "${ticket.approvalId}" is already in state "${ticket.status}".`);
    }

    const resolvedTicket: PendingApprovalTicket = {
      ...ticket,
      status: decision,
      resolvedAt: new Date().toISOString(),
      resolvedBy: operatorIdentity,
      resolutionReason: reason
    };

    this.tickets.set(ticket.approvalId, resolvedTicket);
    this.atomicWrite();
    return resolvedTicket;
  }

  public async saveApprovedResult(result: ApprovedQueryResult): Promise<void> {
    this.approvedResults.set(result.approvalId, result);
    this.atomicWrite();
  }

  public async getApprovedResult(approvalId: string): Promise<ApprovedQueryResult | null> {
    this.initializeFromFile();
    const cleanId = approvalId.replace(/['"]/g, '').trim().toLowerCase();

    let res = this.approvedResults.get(approvalId) || this.approvedResults.get(cleanId);
    if (!res) {
      for (const [id, r] of this.approvedResults.entries()) {
        const lowerId = id.toLowerCase();
        if (lowerId === cleanId || lowerId.startsWith(cleanId) || lowerId.includes(cleanId)) {
          res = r;
          break;
        }
      }
    }

    if (!res) {
      return null;
    }

    if (new Date(res.expiresAt).getTime() <= Date.now()) {
      this.approvedResults.delete(res.approvalId);
      this.atomicWrite();
      return null;
    }

    return res;
  }

  public async purgeExpiredTickets(): Promise<number> {
    this.initializeFromFile();
    const now = Date.now();
    let purgedCount = 0;

    for (const [id, ticket] of this.tickets.entries()) {
      if (new Date(ticket.expiresAt).getTime() <= now) {
        this.tickets.delete(id);
        purgedCount++;
      }
    }

    for (const [id, result] of this.approvedResults.entries()) {
      if (new Date(result.expiresAt).getTime() <= now) {
        this.approvedResults.delete(id);
        purgedCount++;
      }
    }

    if (purgedCount > 0) {
      this.atomicWrite();
    }

    return purgedCount;
  }

  private initializeFromFile(): void {
    // 1. Read primary file first
    try {
      if (existsSync(this.storeFilePath)) {
        const raw = readFileSync(this.storeFilePath, 'utf8').trim();
        if (raw.length > 0) {
          const parsed = JSON.parse(raw) as StoredPayload;
          if (Array.isArray(parsed.tickets)) {
            for (const ticket of parsed.tickets) {
              this.tickets.set(ticket.approvalId, ticket);
            }
          }
          if (Array.isArray(parsed.approvedResults)) {
            for (const res of parsed.approvedResults) {
              this.approvedResults.set(res.approvalId, res);
            }
          }
        }
      }
    } catch {
      // Ignore read errors on primary file
    }

    // 2. Read fallbacks for missing tickets only
    for (const filePath of this.fallbackPaths) {
      if (filePath === this.storeFilePath) continue;
      try {
        if (existsSync(filePath)) {
          const raw = readFileSync(filePath, 'utf8').trim();
          if (raw.length > 0) {
            const parsed = JSON.parse(raw) as StoredPayload;
            if (Array.isArray(parsed.tickets)) {
              for (const ticket of parsed.tickets) {
                if (!this.tickets.has(ticket.approvalId)) {
                  this.tickets.set(ticket.approvalId, ticket);
                }
              }
            }
            if (Array.isArray(parsed.approvedResults)) {
              for (const res of parsed.approvedResults) {
                if (!this.approvedResults.has(res.approvalId)) {
                  this.approvedResults.set(res.approvalId, res);
                }
              }
            }
          }
        }
      } catch {
        // Ignore read errors on fallback files
      }
    }
  }

  private atomicWrite(): void {
    const dir = dirname(this.storeFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const payload: StoredPayload = {
      version: '1.0.0',
      tickets: Array.from(this.tickets.values()),
      approvedResults: Array.from(this.approvedResults.values())
    };

    const tempPath = `${this.storeFilePath}.tmp.${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tempPath, this.storeFilePath);
  }
}
