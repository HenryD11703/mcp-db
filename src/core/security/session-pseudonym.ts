import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { ISessionPseudonymContext } from '../../contracts/federated-query.contract.js';

/**
 * Session-bound ephemeral deterministic pseudonymization context (Principio IV, FR-018 to FR-020).
 * Computes deterministic hashes formatted as `pseudo_<16_hex>` using HMAC-SHA256 with an in-memory 32-byte salt.
 * The salt is never persisted to disk or sent to the client; destroyed upon session termination.
 */
export class SessionPseudonymContext implements ISessionPseudonymContext {
  public readonly sessionId: string;
  private ephemeralSalt: Buffer;
  private readonly cache = new Map<string, string>();

  constructor(sessionId: string = randomUUID(), customSalt?: Buffer) {
    this.sessionId = sessionId;
    this.ephemeralSalt = customSalt ?? randomBytes(32);
  }

  public getPseudonym(rawValue: string | number): string {
    const key = String(rawValue);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    const digest = createHmac('sha256', this.ephemeralSalt)
      .update(key, 'utf8')
      .digest('hex');

    const pseudonym = `pseudo_${digest.slice(0, 16)}`;
    this.cache.set(key, pseudonym);
    return pseudonym;
  }

  public getPseudonymBulk(
    rawValues: ReadonlyArray<string | number>
  ): Map<string | number, string> {
    const result = new Map<string | number, string>();
    for (const val of rawValues) {
      result.set(val, this.getPseudonym(val));
    }
    return result;
  }

  public clearSession(): void {
    this.cache.clear();
    this.ephemeralSalt = randomBytes(32);
  }
}
