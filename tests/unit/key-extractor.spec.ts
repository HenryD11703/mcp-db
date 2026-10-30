import { describe, expect, it } from 'vitest';
import { KeyExtractor } from '../../src/core/federation/key-extractor.js';
import { FederatedKeyLimitExceededError, FederatedQueryError } from '../../src/core/errors.js';

describe('KeyExtractor (User Story 3 - P1 Deduplication, Null Filtering & Limits)', () => {
  it('deduplicates repeating keys and filters null/undefined values', () => {
    const rows = [
      { id: 'K1' },
      { id: 'K2' },
      { id: 'K1' }, // duplicate
      { id: null }, // null
      { id: undefined }, // undefined
      { id: 'K3' },
      { id: 'K2' } // duplicate
    ];

    const result = KeyExtractor.extractKeys(rows, { keyColumn: 'id', maxKeys: 500 });

    expect(result.rawCount).toBe(7);
    expect(result.uniqueKeys).toEqual(['K1', 'K2', 'K3']);
    expect(result.nullCount).toBe(2);
    expect(result.isTruncated).toBe(false);
    expect(result.totalAvailableKeys).toBe(3);
  });

  it('truncates keys when exceeding maxKeys limit under default overflowAction (truncate)', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({ id: `ID_${i + 1}` }));

    const result = KeyExtractor.extractKeys(rows, {
      keyColumn: 'id',
      maxKeys: 5,
      overflowAction: 'truncate'
    });

    expect(result.isTruncated).toBe(true);
    expect(result.totalAvailableKeys).toBe(15);
    expect(result.uniqueKeys).toHaveLength(5);
    expect(result.uniqueKeys).toEqual(['ID_1', 'ID_2', 'ID_3', 'ID_4', 'ID_5']);
  });

  it('throws FederatedKeyLimitExceededError when exceeding maxKeys under overflowAction="fail"', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `ID_${i + 1}` }));

    expect(() =>
      KeyExtractor.extractKeys(rows, {
        keyColumn: 'id',
        maxKeys: 5,
        overflowAction: 'fail'
      })
    ).toThrow(FederatedKeyLimitExceededError);
  });

  it('throws FederatedQueryError when key column does not exist in rows', () => {
    const rows = [{ nombre: 'Alice' }, { nombre: 'Bob' }];

    expect(() =>
      KeyExtractor.extractKeys(rows, { keyColumn: 'non_existent_id' })
    ).toThrow(FederatedQueryError);
  });
});
