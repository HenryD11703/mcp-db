import { describe, expect, it } from 'vitest';
import type { CatalogCapableAdapter, ColumnRef } from '../../../src/contracts/legacy-discovery.contract.js';
import { containmentOnlyScore } from '../../../src/core/discovery/inference-scoring.js';
import { RelationshipInferenceEngine } from '../../../src/core/discovery/relationship-inference-engine.js';
import { relationKey, snapshotOf, table } from '../../fixtures/legacy-schemas.js';

const TABLES = [
  table('usuarios', [['cod_usr', 'varchar'], ['cod_jefe', 'varchar'], ['nombre', 'varchar']], ['cod_usr']),
  table('clientes', [['cod_cli', 'varchar'], ['nombre', 'varchar']], ['cod_cli']),
  table('pagos', [['id_pag', 'int'], ['comprador', 'varchar'], ['cantidad', 'int']], ['id_pag'])
];
const REQUEST = TABLES.map((t) => ({ schema: t.schema, table: t.name }));

function adapterContaining(pairs: ReadonlyArray<string>): CatalogCapableAdapter {
  return {
    getCatalogExtras: async () => ({ tables: [], columns: [], indexes: [] }),
    sampleContainment: async (c: ColumnRef, p: ColumnRef) => {
      const hit = pairs.includes(`${c.table}.${c.column}->${p.table}.${p.column}`);
      return { sampled: 50, matched: hit ? 50 : 0 };
    }
  };
}

describe('value-containment-only inference', () => {
  const engine = new RelationshipInferenceEngine();
  const snapshot = snapshotOf(TABLES);

  it('finds a self-reference and a mismatched name when values are contained', async () => {
    const adapter = adapterContaining(['usuarios.cod_jefe->usuarios.cod_usr', 'pagos.comprador->clientes.cod_cli']);
    const result = await engine.infer({ snapshot, request: { tables: REQUEST }, adapter });
    const keys = result.map(relationKey);
    expect(keys).toContain('usuarios.cod_jefe->usuarios.cod_usr');
    expect(keys).toContain('pagos.comprador->clientes.cod_cli');
    const found = result.find((r) => relationKey(r) === 'pagos.comprador->clientes.cod_cli')!;
    expect(found.level).toBe('MEDIUM');
    expect(found.factors.lexical).toBe(0);
    expect(found.reasons[0]).toMatch(/No name evidence/);
  });

  it('reports nothing when the sampled values are not contained', async () => {
    const result = await engine.infer({ snapshot, request: { tables: REQUEST }, adapter: adapterContaining([]) });
    expect(result).toHaveLength(0);
  });

  it('never probes plain integers or the table\'s own primary key', async () => {
    const probed: string[] = [];
    const adapter: CatalogCapableAdapter = {
      getCatalogExtras: async () => ({ tables: [], columns: [], indexes: [] }),
      sampleContainment: async (c) => {
        probed.push(`${c.table}.${c.column}`);
        return { sampled: 50, matched: 50 };
      }
    };
    await engine.infer({ snapshot, request: { tables: REQUEST }, adapter });
    expect(probed).not.toContain('pagos.cantidad');
    expect(probed).not.toContain('pagos.id_pag');
    expect(probed).not.toContain('usuarios.cod_usr');
  });

  it('does not run without statistical verification', async () => {
    const adapter = adapterContaining(['usuarios.cod_jefe->usuarios.cod_usr']);
    const result = await engine.infer({
      snapshot,
      request: { tables: REQUEST, verifyStatistically: false },
      adapter
    });
    expect(result).toHaveLength(0);
  });

  it('scores strings MEDIUM, integers LOW and thin or partial evidence as zero', () => {
    expect(containmentOnlyScore('varchar', 1, 50)).toBe(0.75);
    expect(containmentOnlyScore('int', 1, 50)).toBe(0.6);
    expect(containmentOnlyScore('varchar', 1, 5)).toBe(0);
    expect(containmentOnlyScore('varchar', 0.9, 50)).toBe(0);
  });
});
