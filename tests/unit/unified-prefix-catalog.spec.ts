import { describe, expect, it } from 'vitest';
import { UnifiedPrefixCatalog } from '../../src/core/security/unified-prefix-catalog.js';

describe('UnifiedPrefixCatalog', () => {
  it('strips organizational, technical and abbreviation prefixes with and without delimiters', () => {
    const catalog = new UnifiedPrefixCatalog();

    // With delimiters
    const res1 = catalog.stripPrefixes('emp_nit');
    expect(res1.prefixes).toEqual(['emp']);
    expect(res1.remainder).toBe('nit');

    // Chained delimiters
    const res2 = catalog.stripPrefixes('t1_col_emp_nit');
    expect(res2.prefixes).toEqual(['t1', 'col', 'emp']);
    expect(res2.remainder).toBe('nit');

    // Continuous string without delimiters (US3 core requirement)
    const res3 = catalog.stripPrefixes('empnit');
    expect(res3.prefixes).toEqual(['emp']);
    expect(res3.remainder).toBe('nit');

    const res4 = catalog.stripPrefixes('galempnit');
    expect(res4.prefixes).toEqual(['gal', 'emp']);
    expect(res4.remainder).toBe('nit');

    const res5 = catalog.stripPrefixes('clinit');
    expect(res5.prefixes).toEqual(['cli']);
    expect(res5.remainder).toBe('nit');
  });

  it('supports custom prefixes via environment or constructor argument', () => {
    const catalog = new UnifiedPrefixCatalog('custom,orgx');
    expect(catalog.isKnownPrefix('custom')).toBe(true);
    expect(catalog.isKnownPrefix('orgx')).toBe(true);

    const stripped = catalog.stripPrefixes('orgx_emp_nit');
    expect(stripped.prefixes).toEqual(['orgx', 'emp']);
    expect(stripped.remainder).toBe('nit');
  });

  it('does not over-strip non-prefix words', () => {
    const catalog = new UnifiedPrefixCatalog();
    const res = catalog.stripPrefixes('nit');
    expect(res.prefixes).toHaveLength(0);
    expect(res.remainder).toBe('nit');
  });
});
