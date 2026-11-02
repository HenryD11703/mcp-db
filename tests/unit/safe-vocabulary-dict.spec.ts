import { describe, expect, it } from 'vitest';
import { SafeVocabularyDictionary } from '../../src/core/security/safe-vocabulary-dict.js';

describe('SafeVocabularyDictionary (US4)', () => {
  const dict = new SafeVocabularyDictionary();

  it('identifies exact benign commercial and technical words', () => {
    expect(dict.isSafeBenign('unit')).toBe(true);
    expect(dict.isSafeBenign('unit_price')).toBe(true);
    expect(dict.isSafeBenign('unitid')).toBe(true);
    expect(dict.isSafeBenign('units')).toBe(true);
    expect(dict.isSafeBenign('monitor')).toBe(true);
    expect(dict.isSafeBenign('monitor_status')).toBe(true);
    expect(dict.isSafeBenign('benito')).toBe(true);
    expect(dict.isSafeBenign('manito')).toBe(true);
    expect(dict.isSafeBenign('definition')).toBe(true);
    expect(dict.isSafeBenign('unanimity')).toBe(true);
    expect(dict.isSafeBenign('cell_count')).toBe(true);
    expect(dict.isSafeBenign('celebrity_id')).toBe(true);
    expect(dict.isSafeBenign('salient_feature')).toBe(true);
    expect(dict.isSafeBenign('salad_type')).toBe(true);
    expect(dict.isSafeBenign('balance_sheet_id')).toBe(true);
    expect(dict.isSafeBenign('monto_total_items')).toBe(true);
  });

  it('does NOT treat true sensitive columns as benign', () => {
    expect(dict.isSafeBenign('nit')).toBe(false);
    expect(dict.isSafeBenign('dpi')).toBe(false);
    expect(dict.isSafeBenign('email')).toBe(false);
    expect(dict.isSafeBenign('telefono')).toBe(false);
    expect(dict.isSafeBenign('salario')).toBe(false);
    expect(dict.isSafeBenign('emp_nit')).toBe(false);
  });
});
