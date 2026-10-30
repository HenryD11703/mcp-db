import { describe, expect, it } from 'vitest';
import {
  entityMatchStrength,
  entityTokensOfColumn,
  entityTokensOfTable,
  isGenericColumn,
  singularize,
  tokenize
} from '../../../src/core/discovery/name-tokenizer.js';
import {
  combineScore,
  levelOf,
  lexicalScore,
  typeCompatibility
} from '../../../src/core/discovery/inference-scoring.js';

describe('name tokenizer', () => {
  it('splits snake_case, camelCase and digits', () => {
    expect(tokenize('id_Cliente')).toEqual(['id', 'cliente']);
    expect(tokenize('codArticulo2')).toEqual(['cod', 'articulo', '2']);
    expect(tokenize('Descripción')).toEqual(['descripcion']);
  });

  it('singularizes Spanish and English plurals', () => {
    expect(singularize('clientes')).toBe('cliente');
    expect(singularize('ordenes')).toBe('orden');
    expect(singularize('usuarios')).toBe('usuario');
  });

  it('expands legacy abbreviations and drops id markers', () => {
    expect(entityTokensOfColumn('cod_cli')).toEqual(['cliente']);
    expect(entityTokensOfColumn('usr_id')).toEqual(['usuario']);
    expect(entityTokensOfColumn('id')).toEqual([]);
  });

  it('removes noise prefixes from table names', () => {
    expect(entityTokensOfTable('mae_clientes')).toEqual(['cliente']);
    expect(entityTokensOfTable('TBL_CTA_CTE')).toEqual(['cta', 'cte']);
  });

  it('flags generic columns', () => {
    for (const name of ['id', 'status', 'fecha', 'tipo', 'codigo', 'descripcion']) {
      expect(isGenericColumn(name)).toBe(true);
    }
    expect(isGenericColumn('cod_cli')).toBe(false);
  });

  it('trusts abbreviation prefixes only for single-word tables', () => {
    expect(entityMatchStrength(['cli'], ['cliente'])).toBeGreaterThan(0.8);
    expect(entityMatchStrength(['cliente'], ['cliente', 'historial'])).toBe(0);
  });
});

describe('inference scoring', () => {
  it('maps scores to confidence levels at the specified thresholds', () => {
    expect(levelOf(0.85)).toBe('HIGH');
    expect(levelOf(0.849)).toBe('MEDIUM');
    expect(levelOf(0.65)).toBe('MEDIUM');
    expect(levelOf(0.649)).toBe('LOW');
  });

  it('caps confidence at 0.84 without statistical evidence', () => {
    expect(combineScore({ lexical: 1, typeCompat: 1, statistical: null })).toBe(0.84);
    expect(combineScore({ lexical: 1, typeCompat: 1, statistical: 1 })).toBe(1);
  });

  it('discards incompatible types and zero lexical evidence', () => {
    expect(typeCompatibility('date', 'varchar')).toBe(0);
    expect(typeCompatibility('int', 'varchar')).toBe(0);
    expect(typeCompatibility('int', 'bigint')).toBe(1);
    expect(typeCompatibility('integer', 'numeric')).toBe(0.7);
    expect(combineScore({ lexical: 0, typeCompat: 1, statistical: 1 })).toBe(0);
    expect(combineScore({ lexical: 1, typeCompat: 0, statistical: 1 })).toBe(0);
  });

  it('never links generic homonyms such as status or fecha', () => {
    const r = lexicalScore({
      childTable: 'pedidos',
      childColumn: 'status',
      parentTable: 'productos',
      parentColumn: 'status'
    });
    expect(r.score).toBe(0);
  });

  it('scores id-style columns against generic parent keys highly', () => {
    const r = lexicalScore({
      childTable: 'pedidos',
      childColumn: 'id_cliente',
      parentTable: 'clientes',
      parentColumn: 'id'
    });
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
