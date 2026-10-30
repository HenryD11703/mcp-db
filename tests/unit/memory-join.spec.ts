import { describe, expect, it } from 'vitest';
import { InMemoryHashJoin } from '../../src/core/federation/memory-join.js';

describe('InMemoryHashJoin (User Story 1 - P1 MVP)', () => {
  const sourceRows = [
    { id: 1, cliente_id: 'C01', nombre: 'Alice', fecha: '2026-01-01' },
    { id: 2, cliente_id: 'C02', nombre: 'Bob', fecha: '2026-01-02' },
    { id: 3, cliente_id: 'C03', nombre: 'Charlie', fecha: '2026-01-03' }
  ];

  const targetRows = [
    { id: 101, id_cliente: 'C01', fecha: '2026-02-01', monto: 500 },
    { id: 102, id_cliente: 'C02', fecha: '2026-02-02', monto: 1200 },
    { id: 103, id_cliente: 'C02', fecha: '2026-02-03', monto: 300 } // multiple matches for C02
  ];

  it('performs LEFT join by default and preserves unmatched source rows with null target columns', () => {
    const result = InMemoryHashJoin.execute({
      sourceRows,
      sourceKeyColumn: 'cliente_id',
      targetRows,
      targetJoinColumn: 'id_cliente',
      joinType: 'LEFT'
    });

    expect(result.totalMergedRows).toBe(4); // C01 (1), C02 (2), C03 (1 unmatched)
    
    // C01 match
    const c01 = result.rows.find((r) => r.cliente_id === 'C01');
    expect(c01).toBeDefined();
    expect(c01?.nombre).toBe('Alice');
    expect(c01?.monto).toBe(500);

    // C03 unmatched (LEFT join should retain it with nulls for target columns)
    const c03 = result.rows.find((r) => r.cliente_id === 'C03');
    expect(c03).toBeDefined();
    expect(c03?.nombre).toBe('Charlie');
    expect(c03?.monto).toBeNull();
  });

  it('performs INNER join and discards unmatched source rows', () => {
    const result = InMemoryHashJoin.execute({
      sourceRows,
      sourceKeyColumn: 'cliente_id',
      targetRows,
      targetJoinColumn: 'id_cliente',
      joinType: 'INNER'
    });

    expect(result.totalMergedRows).toBe(3); // C01 (1), C02 (2). C03 is dropped.
    expect(result.rows.some((r) => r.cliente_id === 'C03')).toBe(false);
  });

  it('resolves column collisions by prefixing conflicting target columns with target_<col>', () => {
    const result = InMemoryHashJoin.execute({
      sourceRows,
      sourceKeyColumn: 'cliente_id',
      targetRows,
      targetJoinColumn: 'id_cliente'
    });

    // Both source and target had 'id' and 'fecha'
    const firstRow = result.rows[0];
    expect(firstRow).toBeDefined();
    expect(firstRow?.id).toBe(1); // source preserved
    expect(firstRow?.target_id).toBe(101); // target renamed
    expect(firstRow?.fecha).toBe('2026-01-01'); // source preserved
    expect(firstRow?.target_fecha).toBe('2026-02-01'); // target renamed
    expect(firstRow?.monto).toBe(500); // non-colliding target column untouched
  });

  it('handles empty source rows gracefully', () => {
    const result = InMemoryHashJoin.execute({
      sourceRows: [],
      sourceKeyColumn: 'cliente_id',
      targetRows,
      targetJoinColumn: 'id_cliente'
    });

    expect(result.totalMergedRows).toBe(0);
    expect(result.rows).toHaveLength(0);
  });
});
