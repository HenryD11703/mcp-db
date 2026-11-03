import { describe, expect, it } from 'vitest';
import { scanSqlLexically } from '../../src/core/validation/lexical-scanner.js';

describe('String-Aware Lexical Scanner (Vector 3 & Lexical Guards)', () => {
  it('strictly rejects inline comments (--) outside string literals', () => {
    const result = scanSqlLexically(
      "SELECT id, nombre FROM clientes WHERE activo = 1 -- ocultar filtro",
      'postgres'
    );
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('V03_COMMENT_OBFUSCATION');
  });

  it('strictly rejects block comments (/* */) outside string literals', () => {
    const result = scanSqlLexically(
      'SELECT /* comentario */ id FROM dbo.clientes',
      'tsql'
    );
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('V03_COMMENT_OBFUSCATION');
  });

  it('allows --, /* */, semicolons, and reserved words inside single-quoted string literals', () => {
    const result = scanSqlLexically(
      "SELECT id FROM notas WHERE texto = 'Linea 1 -- no es comentario; /* tampoco */ EXEC sp_who SELECT INTO'",
      'postgres'
    );
    expect(result.allowed).toBe(true);
  });

  it('handles escaped single quotes inside string literals without false positives', () => {
    const result = scanSqlLexically(
      "SELECT id FROM notas WHERE texto = 'O''Reilly -- libro /* edicion */' AND estado = 'ACTIVO'",
      'tsql'
    );
    expect(result.allowed).toBe(true);
  });

  it('rejects stacked queries separated by semicolon outside literals', () => {
    const result = scanSqlLexically('SELECT 1; SELECT 2', 'postgres');
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('V01_STACKED_QUERIES');
  });

  it('rejects T-SQL whitespace-chained EXEC without semicolon', () => {
    const result = scanSqlLexically('SELECT 1 EXEC sp_who', 'tsql');
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('V08_TSQL_IMPLICIT_EXEC');
  });
});

describe('write statements are not mislabelled as session commands', () => {
  it.each([
    "UPDATE t SET p = 1 WHERE a = 'x'",
    'UPDATE tb_productos_catalogo SET precio_venta_publico = 50.00 WHERE prod_sku = ?'
  ])('reports NON_SELECT_ROOT for: %s', async (sql) => {
    const { HardenedAstValidator } = await import('../../src/core/validation/ast-validator.js');
    const verdict = new HardenedAstValidator().validateSelectOnly(sql, 'mysql');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reasonCode).toBe('NON_SELECT_ROOT');
  });

  it('still reports real session commands as V10', async () => {
    const { HardenedAstValidator } = await import('../../src/core/validation/ast-validator.js');
    const verdict = new HardenedAstValidator().validateSelectOnly('SELECT 1; SET search_path TO evil', 'postgres');
    expect(verdict.allowed).toBe(false);
  });
});
