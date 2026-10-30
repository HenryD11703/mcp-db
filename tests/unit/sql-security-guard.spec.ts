import { describe, expect, it } from 'vitest';
import { SqlSecurityGuard } from '../../src/core/security/sql-security-guard.js';

describe('SqlSecurityGuard (AST & Lexical 2-Stage Pipeline)', () => {
  const guard = new SqlSecurityGuard();

  describe('Vector 1: Stacked Queries (;)', () => {
    it('rejects stacked queries with DROP TABLE in tsql and postgres', () => {
      const sql = 'SELECT id, nombre FROM clientes; DROP TABLE logs';
      const tsqlRes = guard.validateQuery(sql, 'tsql');
      const pgRes = guard.validateQuery(sql, 'postgres');

      expect(tsqlRes.allowed).toBe(false);
      expect(tsqlRes.reasonCode).toBe('V01_STACKED_QUERIES');
      expect(pgRes.allowed).toBe(false);
      expect(pgRes.reasonCode).toBe('V01_STACKED_QUERIES');
    });

    it('rejects trailing semicolon to strictly prevent statement chaining', () => {
      const res = guard.validateQuery('SELECT 1;', 'postgres');
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V01_STACKED_QUERIES');
    });
  });

  describe('Vector 2: SELECT INTO table creation', () => {
    it('rejects SELECT INTO in T-SQL and PostgreSQL', () => {
      const tsqlRes = guard.validateQuery(
        'SELECT * INTO copia_clientes FROM clientes',
        'tsql'
      );
      const pgRes = guard.validateQuery(
        'SELECT id, monto INTO TEMP TABLE tmp_tx FROM transacciones',
        'postgres'
      );

      expect(tsqlRes.allowed).toBe(false);
      expect(tsqlRes.reasonCode).toBe('V02_SELECT_INTO');
      expect(pgRes.allowed).toBe(false);
      expect(pgRes.reasonCode).toBe('V02_SELECT_INTO');
    });
  });

  describe('Vector 3: Comment obfuscation (-- and /* */)', () => {
    it('rejects inline comments outside string literals', () => {
      const res = guard.validateQuery(
        'SELECT id FROM usuarios WHERE activo = 1 -- ocultar filtro',
        'postgres'
      );
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V03_COMMENT_OBFUSCATION');
    });

    it('rejects block comments hiding commands', () => {
      const res = guard.validateQuery(
        'SELECT /* DROP TABLE usuarios */ id FROM usuarios',
        'tsql'
      );
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V03_COMMENT_OBFUSCATION');
    });

    it('allows comment-like sequences inside valid string literals', () => {
      const res = guard.validateQuery(
        "SELECT id, nota FROM tickets WHERE nota = 'Error -- revisar /* urgente */ hoy'",
        'postgres'
      );
      expect(res.allowed).toBe(true);
    });
  });

  describe('Vector 4: Mutating CTEs (WITH ... DELETE/UPDATE/INSERT RETURNING)', () => {
    it('rejects CTE with DELETE RETURNING', () => {
      const res = guard.validateQuery(
        'WITH deleted AS (DELETE FROM pedidos WHERE estado = 0 RETURNING *) SELECT * FROM deleted',
        'postgres'
      );
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V04_MUTATING_CTE');
    });

    it('rejects CTE with UPDATE RETURNING', () => {
      const res = guard.validateQuery(
        'WITH upd AS (UPDATE cuentas SET saldo = 0 RETURNING id) SELECT * FROM upd',
        'postgres'
      );
      expect(res.allowed).toBe(false);
      expect(res.reasonCode).toBe('V04_MUTATING_CTE');
    });
  });

  describe('Vector 5: Procedure Calls (EXEC, EXECUTE, CALL) and Non-SELECT Root', () => {
    it('rejects T-SQL EXEC and implicit EXEC inside SELECT', () => {
      const res1 = guard.validateQuery("EXEC sp_executesql N'SELECT 1'", 'tsql');
      const res2 = guard.validateQuery('SELECT 1 EXEC sp_help', 'tsql');

      expect(res1.allowed).toBe(false);
      expect(['V08_PROCEDURE_CALL', 'V08_TSQL_IMPLICIT_EXEC']).toContain(res1.reasonCode);
      expect(res2.allowed).toBe(false);
      expect(['V08_PROCEDURE_CALL', 'V08_TSQL_IMPLICIT_EXEC']).toContain(res2.reasonCode);
    });

    it('rejects CALL stored procedure statements', () => {
      const res = guard.validateQuery('CALL reset_admin_passwords()', 'postgres');
      expect(res.allowed).toBe(false);
      expect(['V08_PROCEDURE_CALL', 'V08_TSQL_IMPLICIT_EXEC', 'NON_SELECT_ROOT']).toContain(
        res.reasonCode
      );
    });

    it('rejects direct DML and DDL statements (INSERT, UPDATE, DELETE, DROP)', () => {
      for (const sql of [
        "INSERT INTO logs VALUES ('x')",
        'UPDATE clientes SET activo = 0',
        'DELETE FROM clientes',
        'DROP TABLE clientes'
      ]) {
        const res = guard.validateQuery(sql, 'postgres');
        expect(res.allowed).toBe(false);
      }
    });
  });

  describe('Vector 6: Forbidden Administrative & System Functions', () => {
    it('rejects pg_terminate_backend, pg_read_file, and xp_cmdshell', () => {
      const r1 = guard.validateQuery('SELECT pg_terminate_backend(1234)', 'postgres');
      const r2 = guard.validateQuery("SELECT pg_read_file('/etc/passwd')", 'postgres');
      const r3 = guard.validateQuery("SELECT xp_cmdshell('whoami')", 'tsql');

      expect(r1.allowed).toBe(false);
      expect(['V05_FORBIDDEN_FUNCTION', 'V05_DANGEROUS_FUNCTIONS']).toContain(r1.reasonCode);
      expect(r2.allowed).toBe(false);
      expect(['V05_FORBIDDEN_FUNCTION', 'V05_DANGEROUS_FUNCTIONS']).toContain(r2.reasonCode);
      expect(r3.allowed).toBe(false);
      expect(['V05_FORBIDDEN_FUNCTION', 'V05_DANGEROUS_FUNCTIONS']).toContain(r3.reasonCode);
    });
  });

  describe('Control: Valid Pure SELECT Queries (0 False Positives)', () => {
    it('approves valid SELECT queries with JOINs, WHERE, GROUP BY, and CTEs', () => {
      const queries = [
        'SELECT id, nombre, correo FROM clientes WHERE activo = 1 ORDER BY id DESC',
        'SELECT c.id, COUNT(p.id) AS total FROM clientes c INNER JOIN pedidos p ON p.cliente_id = c.id GROUP BY c.id HAVING COUNT(p.id) > 2',
        'WITH resumen AS (SELECT cliente_id, SUM(monto) AS total FROM facturas GROUP BY cliente_id) SELECT * FROM resumen WHERE total > 1000'
      ];

      for (const q of queries) {
        expect(guard.validateQuery(q, 'postgres').allowed).toBe(true);
        expect(guard.validateQuery(q, 'tsql').allowed).toBe(true);
      }
    });
  });
});
