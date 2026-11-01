// Deterministic baseline: how much of the schema do the discovery tools alone recover?
import { performance } from 'node:perf_hooks';
import { connect } from './mcp-client.mjs';
import { tables } from './spec.mjs';
import { score } from './score.mjs';

const s = await connect();
const report = {};
for (const adapterId of ['pg', 'mssql']) {
  const names = tables.map((t) => t.name);
  report[adapterId] = {};
  for (const minConfidence of [0.5, 0.7, 0.85]) {
    const t0 = performance.now();
    const r = await s.call('infer_table_relationships', { adapterId, tables: names, minConfidence });
    const ms = Math.round(performance.now() - t0);
    if (!r.json) {
      report[adapterId][minConfidence] = { error: r.text.slice(0, 300) };
      continue;
    }
    const found = r.json.relationships.map((x) => ({
      child: `${x.child.table}.${x.child.column}`,
      parent: `${x.parent.table}.${x.parent.column}`
    }));
    report[adapterId][minConfidence] = { ms, ...score(found) };
  }
}
await s.close();
console.log(JSON.stringify(report, null, 2));
