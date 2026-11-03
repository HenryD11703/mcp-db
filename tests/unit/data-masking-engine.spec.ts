import { describe, expect, it } from 'vitest';
import type { QueryExecutionResult } from '../../src/contracts/database-adapter.js';
import { DataMaskingEngine } from '../../src/core/security/data-masking-engine.js';
import { buildDefaultMaskingRules } from '../../src/core/security/default-masking-profile.js';
import type { MaskingProfile } from '../../src/contracts/security.contract.js';

describe('DataMaskingEngine (In-Memory PII & Financial Masking)', () => {
  const maskAmountsProfile: MaskingProfile = {
    profileName: 'amounts-on',
    description: 'default rules with business-amount masking enabled',
    rules: buildDefaultMaskingRules(true)
  };
  const engine = new DataMaskingEngine(maskAmountsProfile);

  it('masks emails, phones, Guatemala DPI, and monetary amounts by column name', () => {
    const rawResult: QueryExecutionResult = {
      columns: [
        { name: 'id', dataType: 'int' },
        { name: 'nombre', dataType: 'varchar' },
        { name: 'correo_electronico', dataType: 'varchar' },
        { name: 'telefono_movil', dataType: 'varchar' },
        { name: 'numero_dpi', dataType: 'varchar' },
        { name: 'salario_mensual', dataType: 'decimal' }
      ],
      rows: [
        {
          id: 101,
          nombre: 'Carlos Mendoza',
          correo_electronico: 'juan.perez@empresa.com.gt',
          telefono_movil: '+502 5555-1234',
          numero_dpi: '2458 91234 0101',
          salario_mensual: 12500.0
        }
      ],
      rowCount: 1,
      durationMs: 2
    };

    const masked = engine.maskDataset(rawResult);
    expect(masked.rowCount).toBe(1);
    expect(masked.maskedCellsCount).toBe(4);

    const row = masked.rows[0]!;
    expect(row['id']).toBe(101);
    expect(row['nombre']).toBe('Carlos Mendoza');
    expect(row['correo_electronico']).toBe('j***z@empresa.com.gt');
    expect(row['telefono_movil']).toBe('(***) ***-1234');
    expect(row['numero_dpi']).toBe('*********0101');
    expect(row['salario_mensual']).toBe('Q [ENMASCARADO]');

    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain('juan.perez@empresa.com.gt');
    expect(serialized).not.toContain('5555-1234');
    expect(serialized).not.toContain('2458 91234 0101');
    expect(serialized).not.toContain('12500');
  });

  it('masks phone/email/dpi columns regardless of naming convention (snake_case, camelCase, acronym-prefixed PascalCase)', () => {
    // Regression for a live legacy schema where "CLTTelefono" (ALLCAPS prefix + PascalCase)
    // slipped past the column-name rule because it required "_" or start/end boundaries.
    const rawResult: QueryExecutionResult = {
      columns: [
        { name: 'CLTId', dataType: 'varchar' },
        { name: 'CLTTelefono', dataType: 'varchar' },
        { name: 'clienteEmail', dataType: 'varchar' },
        { name: 'CLTNombre', dataType: 'varchar' }
      ],
      rows: [
        {
          CLTId: 'C-001',
          CLTTelefono: '24755925',
          clienteEmail: 'ana.gomez@banco.gt',
          CLTNombre: 'Drogueria Centro Historico S.A.'
        }
      ],
      rowCount: 1,
      durationMs: 1
    };

    const masked = engine.maskDataset(rawResult);
    const row = masked.rows[0]!;

    expect(row['CLTTelefono']).toBe('(***) ***-5925');
    expect(row['clienteEmail']).toBe('a***z@banco.gt');
    expect(row['CLTNombre']).toBe('Drogueria Centro Historico S.A.');

    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain('24755925');
    expect(serialized).not.toContain('ana.gomez@banco.gt');
  });

  it('masks sensitive values by content pattern even in generic column names', () => {
    const rawResult: QueryExecutionResult = {
      columns: [
        { name: 'campo_a', dataType: 'varchar' },
        { name: 'campo_b', dataType: 'varchar' },
        { name: 'campo_c', dataType: 'varchar' },
        { name: 'campo_d', dataType: 'varchar' }
      ],
      rows: [
        {
          campo_a: 'ana.gomez@banco.gt',
          campo_b: '2458912340101',
          campo_c: '+502 4433-9876',
          campo_d: 'Q 15,800.50'
        }
      ],
      rowCount: 1,
      durationMs: 1
    };

    const masked = engine.maskDataset(rawResult);
    const row = masked.rows[0]!;

    expect(row['campo_a']).toBe('a***z@banco.gt');
    expect(row['campo_b']).toBe('*********0101');
    expect(row['campo_c']).toBe('(***) ***-9876');
    expect(row['campo_d']).toBe('Q [ENMASCARADO]');
  });

  it('masks multiple sensitive patterns combined inside a single free-text cell', () => {
    const rawResult: QueryExecutionResult = {
      columns: [{ name: 'observaciones', dataType: 'text' }],
      rows: [
        {
          observaciones:
            'Cliente con correo soporte.vip@dominio.gt y DPI 1987 65432 0101 solicitó pago de Q 9,500.00 al tel +502 2233-4455'
        }
      ],
      rowCount: 1,
      durationMs: 1
    };

    const masked = engine.maskDataset(rawResult);
    const text = String(masked.rows[0]!['observaciones']);

    expect(text).toContain('s***p@dominio.gt');
    expect(text).toContain('*********0101');
    expect(text).toContain('Q [ENMASCARADO]');
    expect(text).toContain('(***) ***-4455');
    expect(text).not.toContain('soporte.vip@dominio.gt');
    expect(text).not.toContain('1987 65432 0101');
    expect(text).not.toContain('9,500.00');
    expect(text).not.toContain('2233-4455');
  });

  it('handles null, undefined, and boolean values safely without errors', () => {
    const rawResult: QueryExecutionResult = {
      columns: [
        { name: 'correo', dataType: 'varchar' },
        { name: 'monto', dataType: 'decimal' },
        { name: 'activo', dataType: 'boolean' }
      ],
      rows: [
        {
          correo: null,
          monto: null,
          activo: true
        }
      ],
      rowCount: 1,
      durationMs: 1
    };

    const masked = engine.maskDataset(rawResult);
    expect(masked.rows[0]!['correo']).toBeNull();
    expect(masked.rows[0]!['monto']).toBeNull();
    expect(masked.rows[0]!['activo']).toBe(true);
    expect(masked.maskedCellsCount).toBe(0);
  });

  it('leaves business amounts readable by default but still masks salaries', () => {
    const defaults = new DataMaskingEngine();
    const result: QueryExecutionResult = {
      columns: [
        { name: 'monto_total', dataType: 'decimal' },
        { name: 'saldo', dataType: 'decimal' },
        { name: 'salario_mensual', dataType: 'decimal' },
        { name: 'nota', dataType: 'text' }
      ],
      rows: [{ monto_total: 1250.5, saldo: 80, salario_mensual: 9000, nota: 'cobro de Q 9,500.00' }],
      rowCount: 1,
      durationMs: 1
    };
    const row = defaults.maskDataset(result).rows[0]!;
    expect(row['monto_total']).toBe(1250.5);
    expect(row['saldo']).toBe(80);
    expect(row['nota']).toBe('cobro de Q 9,500.00');
    expect(row['salario_mensual']).toBe('Q [ENMASCARADO]');
  });
});
