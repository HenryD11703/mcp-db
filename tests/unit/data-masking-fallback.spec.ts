import { describe, expect, it } from 'vitest';
import { DataMaskingEngine } from '../../src/core/security/data-masking-engine.js';
import type { QueryExecutionResult } from '../../src/contracts/database-adapter.js';

describe('DataMaskingEngine Content Fallback with Modulo 11 (US5)', () => {
  const engine = new DataMaskingEngine();

  it('masks valid NIT in opaque alias column via content-pattern fallback', () => {
    const input: QueryExecutionResult = {
      columns: [{ name: 'codigo_opaco', dataType: 'string' }],
      rows: [
        { codigo_opaco: '1234567-4' },
        { codigo_opaco: 'NIT 345678-K registrado' }
      ],
      rowCount: 2,
      durationMs: 5
    };

    const masked = engine.maskDataset(input);
    expect(masked.maskedCellsCount).toBe(2);
    expect(masked.rows[0]?.['codigo_opaco']).toContain('*******-4');
    expect(masked.rows[1]?.['codigo_opaco']).toContain('******-K');
  });

  it('does NOT mask generic numbers or years in opaque alias columns', () => {
    const input: QueryExecutionResult = {
      columns: [{ name: 'numero_generico', dataType: 'string' }],
      rows: [
        { numero_generico: '2024' },
        { numero_generico: '100' },
        { numero_generico: '54321' }
      ],
      rowCount: 3,
      durationMs: 3
    };

    const masked = engine.maskDataset(input);
    expect(masked.maskedCellsCount).toBe(0);
    expect(masked.rows[0]?.['numero_generico']).toBe('2024');
    expect(masked.rows[1]?.['numero_generico']).toBe('100');
    expect(masked.rows[2]?.['numero_generico']).toBe('54321');
  });
});
