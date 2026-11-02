import { describe, expect, it } from 'vitest';
import { HardenedAstValidator } from '../../src/core/validation/ast-validator.js';
import { verifySqlitePathAndPermissions } from '../../src/adapters/sqlite/sqlite-preflight.js';
import { validateSqlitePragma } from '../../src/adapters/sqlite/sqlite-security.js';

describe('Adversarial Multi-Engine Attack Surface Suite (US1 & US2)', () => {
  const validator = new HardenedAstValidator();

  describe('MySQL / MariaDB Attack Vectors', () => {
    it('[ADV-MYSQL-V01] rejects stacked queries with semicolon', () => {
      const res = validator.validateSelectOnly('SELECT 1; DROP TABLE users', 'mysql');
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V01_STACKED_QUERIES');
    });

    it('[ADV-MYSQL-V03] rejects hash (#) inline comment evasion outside literals', () => {
      const res = validator.validateSelectOnly('SELECT * FROM users # bypass guard', 'mysql');
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V03_COMMENT_OBFUSCATION');
    });

    it('[ADV-MYSQL-V08] rejects dangerous file and system execution functions', () => {
      const res1 = validator.validateSelectOnly("SELECT LOAD_FILE('/etc/passwd')", 'mysql');
      expect(res1.allowed).toBe(false);

      const res2 = validator.validateSelectOnly("SELECT sys_eval('id')", 'mysql');
      expect(res2.allowed).toBe(false);
    });

    it('[ADV-MYSQL-V09] rejects delay DoS functions sleep() and benchmark()', () => {
      const res1 = validator.validateSelectOnly('SELECT sleep(5)', 'mysql');
      expect(res1.allowed).toBe(false);
      expect(res1.reasonCode).toBe('V09_DELAY_DOS');

      const res2 = validator.validateSelectOnly('SELECT benchmark(5000000, MD5(1))', 'mysql');
      expect(res2.allowed).toBe(false);
      expect(res2.reasonCode).toBe('V09_DELAY_DOS');
    });

    it('[ADV-MYSQL-V10] rejects mutating session commands', () => {
      const res = validator.validateSelectOnly('SET GLOBAL read_only = 0', 'mysql');
      expect(res.allowed).toBe(false);
      expect(['V10_SESSION_OR_INTERNAL_CMD', 'NON_SELECT_ROOT']).toContain(res.reasonCode);
    });
  });

  describe('SQLite Attack Vectors', () => {
    it('[ADV-SQLITE-PREFLIGHT] strictly blocks :memory: databases', () => {
      const res = verifySqlitePathAndPermissions(':memory:', ['/valid/dir']);
      expect(res.isReadOnly).toBe(false);
      expect(res.violations.some((v) => v.includes(':memory:'))).toBe(true);
    });

    it('[ADV-SQLITE-PREFLIGHT] strictly blocks path traversal outside whitelist', () => {
      const res = verifySqlitePathAndPermissions('/valid/dir/../../etc/passwd', ['/valid/dir']);
      expect(res.isReadOnly).toBe(false);
      expect(res.violations.some((v) => v.includes('whitelist') || v.includes('allowed'))).toBe(true);
    });

    it('[ADV-SQLITE-PRAGMA] blocks mutating PRAGMAs (journal_mode, writable_schema)', () => {
      const res1 = validateSqlitePragma('PRAGMA journal_mode = WAL');
      expect(res1.allowed).toBe(false);
      expect(res1.reasonCode).toBe('V10_SESSION_OR_INTERNAL_CMD');

      const res2 = validateSqlitePragma('PRAGMA writable_schema = ON');
      expect(res2.allowed).toBe(false);
      expect(res2.reasonCode).toBe('V10_SESSION_OR_INTERNAL_CMD');
    });

    it('[ADV-SQLITE-V04] rejects mutating CTEs in SQLite dialect', () => {
      const res = validator.validateSelectOnly('WITH x AS (DELETE FROM users) SELECT * FROM x', 'sqlite');
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V04_MUTATING_CTE');
    });
  });
});
