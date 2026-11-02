// ~100-table synthetic legacy ERP, no declared FKs, seeded so both engines get identical data.
// Mix of easy edges (same column name), name variants, opaque names and self references, plus decoys.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const r = rng(7);
const int = (n) => Math.floor(r() * n);
const pick = (a) => a[int(a.length)];
const pad = (n, w) => String(n).padStart(w, '0');

const ENTITIES = [
  'cli', 'prv', 'art', 'suc', 'reg', 'prd', 'usr', 'ban', 'mon', 'pai',
  'ciu', 'dep', 'emp', 'cta', 'alm', 'cat', 'mar', 'uni', 'imp', 'des',
  'ven', 'zon', 'rut', 'veh', 'cho', 'tur', 'pro', 'ctr', 'ser', 'ref'
];
const KEY_STYLES = ['cod_', 'id_', 'num_', 'cod_', 'cod_', 'id_'];
const CHILD_KINDS = ['MVR', 'DET', 'HST', 'LOG', 'REL', 'CTL', 'TRX', 'REG', 'AUD', 'DOC'];
const OPAQUE = ['ref', 'rel', 'vinc', 'origen', 'dest', 'resp', 'dueno', 'ext', 'asoc', 'par'];

export const tables = [];
export const truth = [];
const data = {};
const masters = [];

// ---- masters (30): key column, 10..400 rows, mixed key types and value ranges
ENTITIES.forEach((e, i) => {
  const style = KEY_STYLES[i % KEY_STYLES.length];
  const isInt = i % 5 < 2; // 40% integer keys
  const keyName = `${style}${e}`;
  const rows = [10, 25, 60, 120, 250, 400][i % 6];
  const base = i % 2 === 0 ? 1 : 10000 * (1 + (i % 7)); // half dense from 1, half offset ranges
  const keys = Array.from({ length: rows }, (_, k) => (isInt ? base + k : `${e.toUpperCase()}-${pad(k + 1, 4)}`));
  const hasParent = i % 10 === 3; // self reference (hard)
  const cols = [[keyName, isInt ? 'INT' : 'VARCHAR(12)', 'pk'], [`nom_${e}`, 'VARCHAR(60)']];
  if (hasParent) cols.push(['cod_padre', isInt ? 'INT' : 'VARCHAR(12)']);
  const name = `MST_${e.toUpperCase()}`;
  tables.push({ name, cols, rows });
  const m = { e, name, keyName, isInt, keys };
  masters.push(m);
  data[name] = keys.map((k, idx) => {
    const row = [k, `${e} ${idx + 1}`];
    if (hasParent) row.push(idx < 3 ? null : keys[int(3)]);
    return row;
  });
  if (hasParent) truth.push({ child: `${name}.cod_padre`, parent: `${name}.${keyName}`, hard: true });
});

// ---- children (60): own sole PK + 1..4 references + attributes
for (let i = 0; i < 60; i++) {
  const kind = CHILD_KINDS[i % CHILD_KINDS.length];
  const owner = masters[i % masters.length];
  const name = `${kind}_${owner.e.toUpperCase()}${i >= 30 ? '2' : ''}`;
  if (tables.some((t) => t.name === name)) continue;
  const refCount = 1 + int(4);
  const chosen = new Set([owner]);
  while (chosen.size < refCount) chosen.add(pick(masters));
  const composite = i % 12 === 5;
  const rows = 300 + int(1200);
  const cols = [];
  const refs = [];
  let opaqueN = 0;
  [...chosen].forEach((m, idx) => {
    const roll = r();
    let colName;
    let hard = false;
    if (roll < 0.62) colName = m.keyName;
    else if (roll < 0.82) colName = `${m.keyName}_${pick(['ori', 'ped', 'ext', 'aux'])}`;
    else {
      colName = `${pick(OPAQUE)}${++opaqueN}`;
      hard = true;
    }
    if (cols.some((c) => c[0] === colName)) colName = `${colName}_${idx}`;
    cols.push([colName, m.isInt ? 'INT' : 'VARCHAR(12)']);
    refs.push({ m, colName, hard });
  });
  const pkName = composite ? refs[0].colName : `id_${name.toLowerCase()}`;
  if (!composite) cols.unshift([pkName, 'INT', 'pk']);
  else {
    cols.find((c) => c[0] === pkName).push('pk');
    cols.push(['lin', 'INT', 'pk']);
  }
  cols.push(['fec', 'DATE'], ['monto', 'DECIMAL(18,2)'], ['estado', 'VARCHAR(5)']);
  tables.push({ name, cols, rows });
  const colIndex = Object.fromEntries(cols.map((c, k) => [c[0], k]));
  const out = [];
  for (let k = 0; k < rows; k++) {
    const row = new Array(cols.length).fill(null);
    if (!composite) row[colIndex[pkName]] = k + 1;
    else {
      // composite: (first ref, lin) must be unique -> spread lines per key
      row[colIndex['lin']] = Math.floor(k / refs[0].m.keys.length) + 1;
      row[colIndex[pkName]] = refs[0].m.keys[k % refs[0].m.keys.length];
    }
    refs.forEach(({ m, colName }) => {
      if (composite && colName === pkName) return;
      row[colIndex[colName]] = r() < 0.04 ? null : pick(m.keys);
    });
    row[colIndex.fec] = `2026-${pad(1 + int(10), 2)}-${pad(1 + int(28), 2)}`;
    row[colIndex.monto] = (r() * 9000).toFixed(2);
    row[colIndex.estado] = pick(['A', 'B', 'C']);
    out.push(row);
  }
  data[name] = out;
  refs.forEach(({ m, colName, hard }) => truth.push({ child: `${name}.${colName}`, parent: `${m.name}.${m.keyName}`, ...(hard ? { hard: true } : {}) }));
}

// ---- decoys (10)
const decoyOf = (m, n) => {
  const name = `AUX_${m.e.toUpperCase()}${n}`;
  const rows = 150;
  tables.push({ name, cols: [[`id_aux${n}`, 'INT', 'pk'], [m.keyName, m.isInt ? 'INT' : 'VARCHAR(12)'], ['nota', 'VARCHAR(30)']], rows });
  data[name] = Array.from({ length: rows }, (_, k) => [
    k + 1,
    m.isInt ? 900000 + int(500) : `ZZ-${pad(int(9000), 5)}`, // same column name, disjoint values
    `n${k}`
  ]);
};
[0, 3, 6, 9].forEach((i, n) => decoyOf(masters[i], n));
for (let n = 0; n < 6; n++) {
  const name = `TMP_${pad(n, 2)}`;
  const rows = 80;
  tables.push({ name, cols: [['id', 'INT', 'pk'], ['num_lote', 'INT'], ['estado', 'VARCHAR(5)']], rows });
  data[name] = Array.from({ length: rows }, (_, k) => [k + 1, 1 + int(20), pick(['OK', 'ERR'])]);
}

export function generateRows() {
  return data;
}
export const pk = (t) => tables.find((x) => x.name === t).cols.filter((c) => c[2] === 'pk').map((c) => c[0]);
