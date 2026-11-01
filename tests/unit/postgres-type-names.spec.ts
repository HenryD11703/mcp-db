import { describe, expect, it } from 'vitest';
import { pgTypeName } from '../../src/adapters/postgres/postgres-adapter.js';

describe('pgTypeName', () => {
  it('turns well-known type OIDs into readable names', () => {
    expect(pgTypeName(1043)).toBe('varchar');
    expect(pgTypeName(23)).toBe('int4');
    expect(pgTypeName(1700)).toBe('numeric');
    expect(pgTypeName(1082)).toBe('date');
  });

  it('keeps the oid for custom types so nothing is lost', () => {
    expect(pgTypeName(999999)).toBe('oid:999999');
  });
});
