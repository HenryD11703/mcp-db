import { describe, expect, it } from 'vitest';
import { LexicalColumnAnalyzer } from '../../src/core/security/lexical-column-analyzer.js';

describe('Lexical Boundary States & Confidence (US4)', () => {
  const analyzer = new LexicalColumnAnalyzer();

  it('routes benign sub-sequence terms directly to confidence: none (never fail-safe)', () => {
    const benignColumns = [
      'unit',
      'unit_price',
      'unitId',
      'monitor',
      'monitor_status',
      'benito',
      'definition',
      'unanimity',
      'cell_count',
      'celebrity_id',
      'salient_feature',
      'salad_type',
      'balance_sheet_id',
      'monto_total_items',
      'status',
      'created_at'
    ];

    for (const col of benignColumns) {
      const res = analyzer.classifyColumn(col);
      expect(res.isSensitive).toBe(false);
      expect(res.confidence).toBe('none');
    }
  });

  it('routes compound sensitive columns to confidence: deterministic', () => {
    const sensitiveColumns = [
      'empnit',
      'galempnit',
      'clinit',
      'nitempleado',
      'nitno',
      'emp_nit',
      'gal_dpi',
      'doc_identidad',
      'correo_electronico',
      'telefonoCelular',
      'sueldo_base'
    ];

    for (const col of sensitiveColumns) {
      const res = analyzer.classifyColumn(col);
      expect(res.isSensitive).toBe(true);
      expect(res.confidence).toBe('deterministic');
    }
  });

  it('never downgrades positive column name match even if value looks unusual', () => {
    const res = analyzer.classifyColumn('empnit');
    expect(res.isSensitive).toBe(true);
    expect(res.dataType).toBe('nit');
    expect(res.confidence).toBe('deterministic');
  });
});
