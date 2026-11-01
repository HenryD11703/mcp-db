import { describe, expect, it } from 'vitest';
import type { CatalogCapableAdapter, ColumnRef } from '../../../src/contracts/legacy-discovery.contract.js';
import { buildMultiContainmentSql, MAX_MULTI_CONTAINMENT_PARENTS } from '../../../src/core/discovery/containment-sql.js';
import { RelationshipInferenceEngine } from '../../../src/core/discovery/relationship-inference-engine.js';
import { relationKey, snapshotOf, table } from '../../fixtures/legacy-schemas.js';

const ref = (t: string, c: string): ColumnRef => ({ schema: 'dbo', table: t, column: c });

describe('buildMultiContainmentSql', () => {
  const parents = [ref('a', 'k'), ref('b', 'k')];

  it('takes one bounded sample and one counter per parent (PostgreSQL)', () => {
    const sql = buildMultiContainmentSql('postgres', ref('c', 'x'), parents, 500);
    expect(sql).toContain('LIMIT 100');
    expect(sql).toContain('LEFT JOIN "dbo"."a" p0 ON p0."k" = s.v');
    expect(sql).toContain('LEFT JOIN "dbo"."b" p1 ON p1."k" = s.v');
    expect(sql).toContain('AS m0');
    expect(sql).toContain('AS m1');
    expect(sql.match(/LIMIT/g)).toHaveLength(1);
  });

  it('uses TOP and brackets on T-SQL', () => {
    const sql = buildMultiContainmentSql('tsql', ref('c', 'x'), parents, 50);
    expect(sql).toContain('TOP (50)');
    expect(sql).toContain('LEFT JOIN [dbo].[a] p0 ON p0.[k] = s.v');
  });

  it('rejects empty and oversized parent lists', () => {
    expect(() => buildMultiContainmentSql('postgres', ref('c', 'x'), [], 10)).toThrow();
    const many = Array.from({ length: MAX_MULTI_CONTAINMENT_PARENTS + 1 }, (_, i) => ref(`t${i}`, 'k'));
    expect(() => buildMultiContainmentSql('postgres', ref('c', 'x'), many, 10)).toThrow();
  });
});

/** Fake engine: `contains` lists "child.col->parent.col" pairs whose values are fully contained. */
function fakeAdapter(contains: ReadonlyArray<string>, opts: { batch?: boolean; batchFails?: boolean } = {}) {
  const calls = { many: 0, pair: 0 };
  const key = (c: ColumnRef, p: ColumnRef) => `${c.table}.${c.column}->${p.table}.${p.column}`;
  const adapter: CatalogCapableAdapter = {
    getCatalogExtras: async () => ({ tables: [], columns: [], indexes: [] }),
    sampleContainment: async (c, p) => {
      calls.pair++;
      return { sampled: 50, matched: contains.includes(key(c, p)) ? 50 : 0 };
    },
    ...(opts.batch === false
      ? {}
      : {
          sampleContainmentMany: async (c, parents) => {
            calls.many++;
            if (opts.batchFails) throw new Error('collation conflict');
            return parents.map((p) => ({ sampled: 50, matched: contains.includes(key(c, p)) ? 50 : 0 }));
          }
        })
  };
  return { adapter, calls };
}

const TABLES = [
  table('empleado', [['cod_emp', 'varchar'], ['jefe', 'varchar'], ['sede', 'varchar']], ['cod_emp']),
  table('cliente', [['cod_cli', 'varchar'], ['nombre', 'varchar']], ['cod_cli']),
  table('proveedor', [['cod_prv', 'varchar'], ['nombre', 'varchar']], ['cod_prv']),
  table('venta', [['id_venta', 'int'], ['comprador', 'varchar'], ['cod_cli_ori', 'varchar']], ['id_venta'])
];
const REQUEST = TABLES.map((t) => ({ schema: t.schema, table: t.name }));
const engine = new RelationshipInferenceEngine();
const snapshot = snapshotOf(TABLES);

describe('value-containment inference with batched probes', () => {
  it('resolves a column with no name hint using a single batched probe', async () => {
    const { adapter, calls } = fakeAdapter(['venta.comprador->cliente.cod_cli']);
    const result = await engine.infer({ snapshot, request: { tables: REQUEST }, adapter });
    const found = result.find((r) => relationKey(r) === 'venta.comprador->cliente.cod_cli');
    expect(found).toBeDefined();
    expect(found!.ambiguousWith).toBeUndefined();
    expect(calls.many).toBeGreaterThan(0);
  });

  it('reports every equally good parent as ambiguous instead of picking one', async () => {
    const { adapter } = fakeAdapter(['venta.comprador->cliente.cod_cli', 'venta.comprador->proveedor.cod_prv']);
    const result = await engine.infer({ snapshot, request: { tables: REQUEST }, adapter });
    const hits = result.filter((r) => r.child.column === 'comprador');
    expect(hits.map(relationKey).sort()).toEqual([
      'venta.comprador->cliente.cod_cli',
      'venta.comprador->proveedor.cod_prv'
    ]);
    for (const h of hits) {
      expect(h.ambiguousWith).toHaveLength(1);
      expect(h.reasons.join(' ')).toMatch(/Ambiguous: 2 parent keys/);
      expect(h.score).toBeLessThan(0.75);
    }
  });

  it('drops columns that fit more than five parents, since that says nothing', async () => {
    const masters = Array.from({ length: 7 }, (_, i) => table(`maestro${i}`, [[`cod_m${i}`, 'varchar'], ['nombre', 'varchar']], [`cod_m${i}`]));
    const tables = [...masters, table('hecho', [['id_hecho', 'int'], ['comprador', 'varchar']], ['id_hecho'])];
    const { adapter } = fakeAdapter(masters.map((m, i) => `hecho.comprador->${m.name}.cod_m${i}`));
    const result = await engine.infer({
      snapshot: snapshotOf(tables),
      request: { tables: tables.map((t) => ({ schema: t.schema, table: t.name })) },
      adapter
    });
    expect(result.filter((r) => r.child.column === 'comprador')).toHaveLength(0);
  });

  it('falls back to pair-by-pair probes when the batch fails', async () => {
    const { adapter, calls } = fakeAdapter(['venta.comprador->cliente.cod_cli'], { batchFails: true });
    const result = await engine.infer({ snapshot, request: { tables: REQUEST }, adapter });
    expect(result.map(relationKey)).toContain('venta.comprador->cliente.cod_cli');
    expect(calls.pair).toBeGreaterThan(0);
  });

  it('works with adapters that only implement the pairwise probe', async () => {
    const { adapter, calls } = fakeAdapter(['venta.comprador->cliente.cod_cli'], { batch: false });
    const result = await engine.infer({ snapshot, request: { tables: REQUEST }, adapter });
    expect(result.map(relationKey)).toContain('venta.comprador->cliente.cod_cli');
    expect(calls.many).toBe(0);
  });

  it('finds a self-reference with a single probe batch per column', async () => {
    const { adapter } = fakeAdapter(['empleado.jefe->empleado.cod_emp']);
    const result = await engine.infer({ snapshot, request: { tables: REQUEST }, adapter });
    expect(result.map(relationKey)).toContain('empleado.jefe->empleado.cod_emp');
  });
});

describe('name rules added for larger schemas', () => {
  const T = [
    table('suc_mstr', [['cod_suc', 'varchar'], ['nom_suc', 'varchar']], ['cod_suc']),
    table('log_suc', [['id_log_suc', 'int'], ['cod_suc_ori', 'varchar']], ['id_log_suc']),
    table('aud_imp', [['id_aud_imp', 'int'], ['x', 'varchar']], ['id_aud_imp']),
    table('aud_imp2', [['id_aud_imp2', 'int'], ['y', 'varchar']], ['id_aud_imp2'])
  ];
  const request = T.map((t) => ({ schema: t.schema, table: t.name }));
  const snap = snapshotOf(T);

  it('links a role-suffixed column to the parent key it extends', async () => {
    const result = await engine.infer({ snapshot: snap, request: { tables: request } });
    expect(result.map(relationKey)).toContain('log_suc.cod_suc_ori->suc_mstr.cod_suc');
  });

  it('does not relate a table\'s own identity key to the key of a twin table', async () => {
    const result = await engine.infer({ snapshot: snap, request: { tables: request } });
    const keys = result.map(relationKey);
    expect(keys).not.toContain('aud_imp2.id_aud_imp2->aud_imp.id_aud_imp');
    expect(keys).not.toContain('aud_imp.id_aud_imp->aud_imp2.id_aud_imp2');
  });
});
