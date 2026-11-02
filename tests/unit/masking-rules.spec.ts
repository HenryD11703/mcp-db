import { describe, expect, it } from 'vitest';
import { DEFAULT_MASKING_RULES } from '../../src/core/security/default-masking-profile.js';
import { doesColumnMatchRule } from '../../src/core/security/masking-rules.js';

function phoneRule() {
  return DEFAULT_MASKING_RULES.find((r) => r.id === 'col-phone')!;
}

function emailRule() {
  return DEFAULT_MASKING_RULES.find((r) => r.id === 'col-email')!;
}

function dpiRule() {
  return DEFAULT_MASKING_RULES.find((r) => r.id === 'col-dpi')!;
}

function amountRule() {
  return DEFAULT_MASKING_RULES.find((r) => r.id === 'col-amount')!;
}

describe('doesColumnMatchRule (identifier tokenization across naming conventions)', () => {
  it('matches snake_case columns (baseline, pre-fix behavior)', () => {
    expect(doesColumnMatchRule('telefono_movil', phoneRule())).toBe(true);
    expect(doesColumnMatchRule('correo_electronico', emailRule())).toBe(true);
    expect(doesColumnMatchRule('numero_dpi', dpiRule())).toBe(true);
    expect(doesColumnMatchRule('salario_mensual', amountRule())).toBe(true);
  });

  it('matches acronym-prefixed PascalCase columns ("CLTTelefono" style legacy schemas)', () => {
    expect(doesColumnMatchRule('CLTTelefono', phoneRule())).toBe(true);
    expect(doesColumnMatchRule('CLTCorreoElectronico', emailRule())).toBe(true);
    expect(doesColumnMatchRule('EMPDpi', dpiRule())).toBe(true);
    expect(doesColumnMatchRule('EMPSalarioMensual', amountRule())).toBe(true);
  });

  it('matches plain camelCase columns', () => {
    expect(doesColumnMatchRule('clienteTelefono', phoneRule())).toBe(true);
    expect(doesColumnMatchRule('clienteCorreo', emailRule())).toBe(true);
  });

  it('matches an all-caps column with no prefix', () => {
    expect(doesColumnMatchRule('TELEFONO', phoneRule())).toBe(true);
  });

  it('matches a trailing-digit variant ("CLTTelefono2", a real secondary-phone column)', () => {
    expect(doesColumnMatchRule('CLTTelefono2', phoneRule())).toBe(true);
  });

  it('matches regardless of separator style (dash, space, dot)', () => {
    expect(doesColumnMatchRule('cliente-telefono', phoneRule())).toBe(true);
    expect(doesColumnMatchRule('cliente telefono', phoneRule())).toBe(true);
    expect(doesColumnMatchRule('cliente.telefono', phoneRule())).toBe(true);
  });

  it('does not match unrelated columns that merely contain a short alias as a substring', () => {
    // "hotel" and "detalle" must not match the risky 3-letter "tel" alias.
    expect(doesColumnMatchRule('hotel', phoneRule())).toBe(false);
    expect(doesColumnMatchRule('detalle', phoneRule())).toBe(false);
    expect(doesColumnMatchRule('intelligente', phoneRule())).toBe(false);
  });

  it('does not match columns from a different domain entirely', () => {
    expect(doesColumnMatchRule('CLTNombre', phoneRule())).toBe(false);
    expect(doesColumnMatchRule('CLTNombre', emailRule())).toBe(false);
    expect(doesColumnMatchRule('CLTDireccion', dpiRule())).toBe(false);
    expect(doesColumnMatchRule('CLTEstado', amountRule())).toBe(false);
  });

  it('returns false for a disabled rule even if the name would otherwise match', () => {
    const disabled = { ...phoneRule(), enabled: false };
    expect(doesColumnMatchRule('CLTTelefono', disabled)).toBe(false);
  });
});
