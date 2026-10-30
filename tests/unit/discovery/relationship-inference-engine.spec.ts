import { describe, expect, it } from 'vitest';
import type {
  CatalogCapableAdapter,
  ColumnRef,
  ContainmentSampleOptions
} from '../../../src/contracts/legacy-discovery.contract.js';
import { RelationshipInferenceEngine } from '../../../src/core/discovery/relationship-inference-engine.js';
import {
  LEGACY_EXPECTED,
  LEGACY_TABLES,
  relationKey,
  snapshotOf,
  table
} from '../../fixtures/legacy-schemas.js';

function fakeAdapter(
  sample: (c: ColumnRef, p: ColumnRef, o: ContainmentSampleOptions) => Promise<{ sampled: number; matched: number }>
): CatalogCapableAdapter {
  return {
    getCatalogExtras: async () => ({ tables: [], columns: [], indexes: [] }),
    sampleContainment: sample
  };
}

const ALL_TABLES = LEGACY_TABLES.map((t) => ({ schema: t.schema, table: t.name }));

describe('RelationshipInferenceEngine (name + type evidence only)', () => {
  const engine = new RelationshipInferenceEngine();
  const snapshot = snapshotOf(LEGACY_TABLES);

  it('infers legacy relationships without declared foreign keys', async () => {
    const result = await engine.infer({ snapshot, request: { tables: ALL_TABLES } });
    const keys = result.map(relationKey);
    for (const expected of LEGACY_EXPECTED) {
      expect(keys).toContain(expected);
    }
  });

  it('meets precision/recall targets on the labeled corpus (SC-003)', async () => {
    const result = await engine.infer({ snapshot, request: { tables: ALL_TABLES } });
    const keys = new Set(result.map(relationKey));
    const truePositives = LEGACY_EXPECTED.filter((e) => keys.has(e)).length;
    const falsePositives = [...keys].filter((k) => !LEGACY_EXPECTED.includes(k)).length;
    expect(truePositives / LEGACY_EXPECTED.length).toBeGreaterThanOrEqual(0.85);
    expect(falsePositives / Math.max(1, keys.size)).toBeLessThan(0.1);
  });

  it('never reaches HIGH without statistical evidence', async () => {
    const result = await engine.infer({ snapshot, request: { tables: ALL_TABLES } });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      expect(r.score).toBeLessThanOrEqual(0.84);
      expect(r.level).not.toBe('HIGH');
      expect(r.factors.statistical).toBeNull();
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it('does not relate generic homonyms or incompatible types', async () => {
    const result = await engine.infer({ snapshot, request: { tables: ALL_TABLES } });
    const keys = result.map(relationKey);
    expect(keys.some((k) => k.includes('status'))).toBe(false);
    expect(keys.some((k) => k.includes('fecha_pago') || k.includes('calendario'))).toBe(false);
    // id_cliente must not point to the look-alike history table
    expect(keys).not.toContain('pedidos.id_cliente->cliente_historial.id');
  });

  it('skips columns that already have a declared foreign key', async () => {
    const withFk = snapshotOf(LEGACY_TABLES, null, [
      {
        constraintName: 'fk_ped_cli',
        sourceSchema: 'dbo',
        sourceTable: 'pedidos',
        sourceColumn: 'id_cliente',
        targetSchema: 'dbo',
        targetTable: 'clientes',
        targetColumn: 'id'
      }
    ]);
    const result = await engine.infer({ snapshot: withFk, request: { tables: ALL_TABLES } });
    expect(result.map(relationKey)).not.toContain('pedidos.id_cliente->clientes.id');
  });

  it('honors the minimum confidence threshold and limits scope to requested tables', async () => {
    const strict = await engine.infer({
      snapshot,
      request: { tables: ALL_TABLES, minConfidence: 0.9 }
    });
    expect(strict).toHaveLength(0);

    const scoped = await engine.infer({
      snapshot,
      request: { tables: [{ schema: 'dbo', table: 'log_acceso' }] }
    });
    expect(scoped.map(relationKey)).toEqual(['log_acceso.usr_id->usuarios.id']);
  });

  it('keeps schema-qualified names across schemas', async () => {
    const snap = snapshotOf([
      table('facturas', [['id', 'int'], ['id_usuario', 'int']], ['id'], 'ventas'),
      table('usuarios', [['id', 'int']], ['id'], 'seguridad')
    ]);
    const result = await engine.infer({
      snapshot: snap,
      request: { tables: [{ schema: 'ventas', table: 'facturas' }] }
    });
    expect(result[0]?.child.schema).toBe('ventas');
    expect(result[0]?.parent.schema).toBe('seguridad');
  });
});

describe('RelationshipInferenceEngine (bounded statistical verification)', () => {
  const snapshot = snapshotOf(LEGACY_TABLES);
  const request = { tables: [{ schema: 'dbo', table: 'pedidos' }] };

  it('raises confidence to HIGH when containment is verified', async () => {
    const engine = new RelationshipInferenceEngine();
    const adapter = fakeAdapter(async () => ({ sampled: 50, matched: 50 }));
    const result = await engine.infer({ snapshot, adapter, request });
    const rel = result.find((r) => relationKey(r) === 'pedidos.id_cliente->clientes.id');
    expect(rel?.level).toBe('HIGH');
    expect(rel?.statisticalStatus).toBe('VERIFIED');
    expect(rel?.factors.statistical).toBe(1);
  });

  it('discards candidates contradicted by the sample', async () => {
    const engine = new RelationshipInferenceEngine();
    const adapter = fakeAdapter(async () => ({ sampled: 50, matched: 2 }));
    const result = await engine.infer({ snapshot, adapter, request });
    expect(result).toHaveLength(0);
  });

  it('caps confidence on partial containment', async () => {
    const engine = new RelationshipInferenceEngine();
    const adapter = fakeAdapter(async () => ({ sampled: 100, matched: 80 }));
    const result = await engine.infer({ snapshot, adapter, request });
    const rel = result.find((r) => relationKey(r) === 'pedidos.id_cliente->clientes.id');
    expect(rel?.score).toBeLessThanOrEqual(0.7);
  });

  it('degrades gracefully on timeout without blocking', async () => {
    const engine = new RelationshipInferenceEngine({ sampleTimeoutMs: 20 });
    const adapter = fakeAdapter(
      (_c, _p, o) =>
        new Promise((_resolve, reject) => {
          o.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
        })
    );
    const started = Date.now();
    const result = await engine.infer({ snapshot, adapter, request });
    expect(Date.now() - started).toBeLessThan(2000);
    const rel = result.find((r) => relationKey(r) === 'pedidos.id_cliente->clientes.id');
    expect(rel?.statisticalStatus).toBe('TIMED_OUT');
    expect(rel?.level).not.toBe('HIGH');
  });

  it('only receives aggregate counters and bounded sample sizes', async () => {
    const engine = new RelationshipInferenceEngine({ maxSample: 1000 });
    const seen: number[] = [];
    const adapter = fakeAdapter(async (_c, _p, o) => {
      seen.push(o.maxSample);
      return { sampled: 10, matched: 10 };
    });
    const result = await engine.infer({ snapshot, adapter, request });
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(100);
    const allowed = ['child', 'parent', 'score', 'level', 'factors', 'statisticalStatus', 'reasons'];
    for (const r of result) {
      expect(Object.keys(r).sort()).toEqual([...allowed].sort());
    }
  });

  it('skips verification when requested', async () => {
    const engine = new RelationshipInferenceEngine();
    let calls = 0;
    const adapter = fakeAdapter(async () => {
      calls += 1;
      return { sampled: 1, matched: 1 };
    });
    await engine.infer({
      snapshot,
      adapter,
      request: { ...request, verifyStatistically: false }
    });
    expect(calls).toBe(0);
  });
});
