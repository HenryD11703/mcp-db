import { describe, expect, it } from 'vitest';
import { ParameterBinder } from '../../src/core/federation/parameter-binder.js';
import { FederatedQueryError } from '../../src/core/errors.js';

describe('ParameterBinder (User Story 3 - P1 Anti-SQLi & Typed Injection)', () => {
  it('translates :keys to positional markers ($1, $2, $3) for PostgreSQL with typed params', () => {
    const result = ParameterBinder.bindKeys({
      sqlTemplate: 'SELECT id, nombre FROM usuarios WHERE id IN (:keys)',
      keys: [10, 20, 30],
      dialect: 'postgres'
    });

    expect(result.sql).toBe('SELECT id, nombre FROM usuarios WHERE id IN ($1, $2, $3)');
    expect(result.params).toHaveLength(3);
    expect(result.params[0]).toEqual({ name: '1', type: 'number', value: 10 });
    expect(result.params[1]).toEqual({ name: '2', type: 'number', value: 20 });
    expect(result.params[2]).toEqual({ name: '3', type: 'number', value: 30 });
  });

  it('translates :keys to named markers (@p1, @p2) for SQL Server (T-SQL) with typed params', () => {
    const result = ParameterBinder.bindKeys({
      sqlTemplate: 'SELECT id, monto FROM contratos WHERE id_cliente IN (:keys)',
      keys: ['C001', 'C002'],
      dialect: 'tsql'
    });

    expect(result.sql).toBe('SELECT id, monto FROM contratos WHERE id_cliente IN (@p1, @p2)');
    expect(result.params).toHaveLength(2);
    expect(result.params[0]).toEqual({ name: 'p1', type: 'string', value: 'C001' });
    expect(result.params[1]).toEqual({ name: 'p2', type: 'string', value: 'C002' });
  });

  it('never interpolates adversarial payloads into SQL string (zero concatenation guarantee)', () => {
    const maliciousKeys = ["' OR '1'='1", "'; DROP TABLE users; --", "admin'--", '"><script>'];
    const result = ParameterBinder.bindKeys({
      sqlTemplate: 'SELECT * FROM items WHERE code IN (:keys)',
      keys: maliciousKeys,
      dialect: 'postgres'
    });

    // The SQL text MUST ONLY contain parameter placeholders
    expect(result.sql).toBe('SELECT * FROM items WHERE code IN ($1, $2, $3, $4)');
    // Payload travels strictly via parameter values
    expect(result.params.map((p) => p.value)).toEqual(maliciousKeys);
    for (const payload of maliciousKeys) {
      expect(result.sql.includes(payload)).toBe(false);
    }
  });

  it('throws FederatedQueryError when :keys placeholder is missing', () => {
    expect(() =>
      ParameterBinder.bindKeys({
        sqlTemplate: 'SELECT * FROM items WHERE id = 1',
        keys: [1, 2],
        dialect: 'postgres'
      })
    ).toThrow(FederatedQueryError);
  });

  it('throws FederatedQueryError when keys list is empty', () => {
    expect(() =>
      ParameterBinder.bindKeys({
        sqlTemplate: 'SELECT * FROM items WHERE id IN (:keys)',
        keys: [],
        dialect: 'postgres'
      })
    ).toThrow(FederatedQueryError);
  });
});
