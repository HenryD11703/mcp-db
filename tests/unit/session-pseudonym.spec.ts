import { describe, expect, it } from 'vitest';
import { SessionPseudonymContext } from '../../src/core/security/session-pseudonym.js';

describe('SessionPseudonymContext (User Story 4 - P2 Privacy & Pseudonymization)', () => {
  it('generates pseudonyms matching canonical format pseudo_<16_hex>', () => {
    const context = new SessionPseudonymContext();
    const pseudonym = context.getPseudonym('1029384756');

    expect(pseudonym).toMatch(/^pseudo_[0-9a-f]{16}$/);
    expect(pseudonym).toHaveLength(23); // 'pseudo_' (7) + 16 hex = 23
  });

  it('guarantees deterministic consistency for identical values within the same session', () => {
    const context = new SessionPseudonymContext();
    const val1 = context.getPseudonym('juan.perez@empresa.com.gt');
    const val2 = context.getPseudonym('juan.perez@empresa.com.gt');
    const val3 = context.getPseudonym('maria.lopez@empresa.com.gt');

    expect(val1).toBe(val2);
    expect(val1).not.toBe(val3);
  });

  it('ensures entropy isolation between different sessions (different salts)', () => {
    const sessionA = new SessionPseudonymContext('session-A');
    const sessionB = new SessionPseudonymContext('session-B');

    const pseudoA = sessionA.getPseudonym('DPI_2458912340101');
    const pseudoB = sessionB.getPseudonym('DPI_2458912340101');

    // Pseudonyms MUST be completely different across sessions for the same raw PII
    expect(pseudoA).not.toBe(pseudoB);
  });

  it('supports bulk pseudonymization efficiently', () => {
    const context = new SessionPseudonymContext();
    const map = context.getPseudonymBulk(['A1', 'A2', 'A1']);

    expect(map.size).toBe(2);
    expect(map.get('A1')).toMatch(/^pseudo_[0-9a-f]{16}$/);
    expect(map.get('A2')).toMatch(/^pseudo_[0-9a-f]{16}$/);
  });

  it('rotates salt and clears cache on clearSession()', () => {
    const context = new SessionPseudonymContext();
    const initial = context.getPseudonym('CLIENT_999');

    context.clearSession();
    const afterClear = context.getPseudonym('CLIENT_999');

    expect(initial).not.toBe(afterClear);
  });
});
