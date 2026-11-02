import { describe, expect, it } from 'vitest';
import { DataMaskingEngine } from '../../src/core/security/data-masking-engine.js';
import { SessionContext } from '../../src/core/security/session-pseudonym.js';
import type { QueryExecutionResult } from '../../src/contracts/database-adapter.js';
import type { MaskingProfile } from '../../src/contracts/security.contract.js';

describe('Federated Masking Consistency across Engines (US5)', () => {
  it('enforces deterministic session pseudonym consistency for NIT across distinct engines', () => {
    // Reset ephemeral salt for the test session
    SessionContext.resetDefaultSession();

    const pseudonymProfile: MaskingProfile = {
      profileName: 'pseudonym-profile',
      rules: [
        {
          id: 'rule-nit-pseudonym',
          targetType: 'column_name',
          matcher: /(^|_)(nit)($|_)/i,
          dataType: 'nit',
          strategy: 'session_pseudonym',
          enabled: true
        }
      ]
    };

    const engine = new DataMaskingEngine();

    // Dataset coming from MySQL
    const mysqlResult: QueryExecutionResult = {
      columns: [{ name: 'empnit', dataType: 'varchar' }],
      rows: [{ empnit: '1234567-4' }],
      rowCount: 1,
      durationMs: 4
    };

    // Dataset coming from SQLite
    const sqliteResult: QueryExecutionResult = {
      columns: [{ name: 'gal_nit', dataType: 'TEXT' }],
      rows: [{ gal_nit: '1234567-4' }],
      rowCount: 1,
      durationMs: 2
    };

    const maskedMysql = engine.maskDataset(mysqlResult, pseudonymProfile);
    const maskedSqlite = engine.maskDataset(sqliteResult, pseudonymProfile);

    const mysqlVal = maskedMysql.rows[0]?.['empnit'];
    const sqliteVal = maskedSqlite.rows[0]?.['gal_nit'];

    expect(mysqlVal).toBeDefined();
    expect(sqliteVal).toBeDefined();
    // Same raw NIT across distinct engines produces identical session pseudonym!
    expect(mysqlVal).toBe(sqliteVal);
    expect(String(mysqlVal)).toMatch(/^nit_[a-f0-9]{16}$/);
  });
});
