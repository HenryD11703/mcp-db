import { describe, expect, it } from 'vitest';
import { SqlSanitizerForAudit } from '../../src/core/audit/sql-sanitizer.js';

describe('SqlSanitizerForAudit (User Story 2 - Zero Leakage of Sensitive Literals)', () => {
  const sanitizer = new SqlSanitizerForAudit();

  it('should redact string literals containing sensitive personal data (DPI, emails, phones)', () => {
    const rawSql =
      "SELECT * FROM clientes WHERE dpi = '2458912340101' AND email = 'admin@empresa.com.gt' AND telefono = '502-12345678'";
    const sanitized = sanitizer.sanitizeSqlForAudit(rawSql);

    expect(sanitized).not.toContain('2458912340101');
    expect(sanitized).not.toContain('admin@empresa.com.gt');
    expect(sanitized).not.toContain('502-12345678');

    expect(sanitized).toBe(
      "SELECT * FROM clientes WHERE dpi = '[REDACTED_LITERAL]' AND email = '[REDACTED_LITERAL]' AND telefono = '[REDACTED_LITERAL]'"
    );
  });

  it('should redact string literals with escaped quotes properly', () => {
    const rawSql = "SELECT * FROM notas WHERE comentario = 'O''Reilly and co'";
    const sanitized = sanitizer.sanitizeSqlForAudit(rawSql);

    expect(sanitized).not.toContain("O''Reilly");
    expect(sanitized).toBe("SELECT * FROM notas WHERE comentario = '[REDACTED_LITERAL]'");
  });

  it('should redact numeric constants in comparison predicates and lists', () => {
    const rawSql =
      'SELECT id, nombre, salario FROM empleados WHERE salario >= 15000.50 AND departamento_id IN (10, 20, 30)';
    const sanitized = sanitizer.sanitizeSqlForAudit(rawSql);

    expect(sanitized).not.toContain('15000.50');
    expect(sanitized).not.toContain('10');
    expect(sanitized).not.toContain('20');
    expect(sanitized).not.toContain('30');

    expect(sanitized).toBe(
      'SELECT id, nombre, salario FROM empleados WHERE salario >= [REDACTED_NUM] AND departamento_id IN ([REDACTED_NUM], [REDACTED_NUM], [REDACTED_NUM])'
    );
  });

  it('should redact numbers in BETWEEN clauses', () => {
    const rawSql = 'SELECT * FROM transacciones WHERE monto BETWEEN 100 AND 500';
    const sanitized = sanitizer.sanitizeSqlForAudit(rawSql);

    expect(sanitized).not.toContain('100');
    expect(sanitized).not.toContain('500');
    expect(sanitized).toBe('SELECT * FROM transacciones WHERE monto BETWEEN [REDACTED_NUM] AND [REDACTED_NUM]');
  });

  it('should enforce truncation at maximum SQL length limit (16 KB)', () => {
    const hugeSanitizer = new SqlSanitizerForAudit(100);
    const hugeSql = 'SELECT * FROM test WHERE a = 1 ' + 'AND b = 2 '.repeat(50);
    const sanitized = hugeSanitizer.sanitizeSqlForAudit(hugeSql);

    expect(sanitized).toContain('[TRUNCATED]');
    expect(sanitized.length).toBeLessThanOrEqual(100 + ' [TRUNCATED]'.length);
  });
});
