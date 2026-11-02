// Synthetic legacy ERP used to measure how well an agent can rebuild a schema with NO declared FKs.
// `truth` is the ground truth the scorer compares against; `hard` marks edges a naive name match misses.

export const tables = [
  { name: 'CLI_MSTR', cols: [['cod_cli', 'VARCHAR(15)', 'pk'], ['nom_cli', 'VARCHAR(80)'], ['nit', 'VARCHAR(20)'], ['cod_seg', 'VARCHAR(5)']], rows: 400 },
  { name: 'REG_CAT', cols: [['cod_reg', 'VARCHAR(5)', 'pk'], ['nom_reg', 'VARCHAR(60)']], rows: 8 },
  { name: 'SUC_MSTR', cols: [['cod_suc', 'INT', 'pk'], ['nom_suc', 'VARCHAR(60)'], ['cod_reg', 'VARCHAR(5)']], rows: 25 },
  { name: 'PRD_MSTR', cols: [['cod_prod', 'VARCHAR(8)', 'pk'], ['dsc_prod', 'VARCHAR(80)']], rows: 12 },
  { name: 'USR_SYS', cols: [['cod_usr', 'VARCHAR(10)', 'pk'], ['nom_usr', 'VARCHAR(60)'], ['cod_suc', 'INT'], ['cod_jefe', 'VARCHAR(10)']], rows: 40 },
  { name: 'CTA_MSTR', cols: [['num_cta', 'INT', 'pk'], ['cod_cli', 'VARCHAR(15)'], ['cod_suc', 'INT'], ['cod_prod', 'VARCHAR(8)'], ['saldo', 'DECIMAL(18,2)']], rows: 600 },
  { name: 'TRX_MVR', cols: [['id_trx', 'INT', 'pk'], ['num_cta', 'INT'], ['cod_usr', 'VARCHAR(10)'], ['fec_trx', 'DATE'], ['monto', 'DECIMAL(18,2)']], rows: 3000 },
  { name: 'LOG_AUT', cols: [['id_log', 'INT', 'pk'], ['id_trx', 'INT'], ['cod_usr', 'VARCHAR(10)'], ['accion', 'VARCHAR(20)']], rows: 800 },
  { name: 'PRV_MSTR', cols: [['cod_prov', 'INT', 'pk'], ['nom_prov', 'VARCHAR(80)']], rows: 30 },
  { name: 'ART_MSTR', cols: [['cod_art', 'VARCHAR(12)', 'pk'], ['dsc_art', 'VARCHAR(80)'], ['cod_prov', 'INT']], rows: 150 },
  { name: 'FAC_HDR', cols: [['num_fac', 'VARCHAR(20)', 'pk'], ['cod_cli', 'VARCHAR(15)'], ['fec_fac', 'DATE'], ['total', 'DECIMAL(18,2)']], rows: 900 },
  { name: 'FAC_DET', cols: [['num_fac', 'VARCHAR(20)', 'pk'], ['lin', 'INT', 'pk'], ['cod_art', 'VARCHAR(12)'], ['cant', 'INT']], rows: 2500 },
  // Hard: column name does not mention the parent entity.
  { name: 'PAG_REL', cols: [['id_pag', 'INT', 'pk'], ['cliente', 'VARCHAR(15)'], ['monto', 'DECIMAL(18,2)']], rows: 500 },
  // Decoys: same column names as real keys but a disjoint value space, or generic ids that overlap by chance.
  { name: 'AUX_TMP01', cols: [['id_aux', 'INT', 'pk'], ['cod_suc', 'INT'], ['cod_cli', 'VARCHAR(15)']], rows: 200 },
  { name: 'CFG_PARAM', cols: [['id', 'INT', 'pk'], ['nom_param', 'VARCHAR(40)'], ['valor', 'VARCHAR(40)']], rows: 30 },
  { name: 'HIST_LOTE', cols: [['id', 'INT', 'pk'], ['num_lote', 'INT'], ['estado', 'VARCHAR(10)']], rows: 100 }
];

const pk = (t) => tables.find((x) => x.name === t).cols.filter((c) => c[2] === 'pk').map((c) => c[0]);

// child.column -> parent.column
export const truth = [
  { child: 'SUC_MSTR.cod_reg', parent: 'REG_CAT.cod_reg' },
  { child: 'USR_SYS.cod_suc', parent: 'SUC_MSTR.cod_suc' },
  { child: 'USR_SYS.cod_jefe', parent: 'USR_SYS.cod_usr', hard: true }, // self reference
  { child: 'CTA_MSTR.cod_cli', parent: 'CLI_MSTR.cod_cli' },
  { child: 'CTA_MSTR.cod_suc', parent: 'SUC_MSTR.cod_suc' },
  { child: 'CTA_MSTR.cod_prod', parent: 'PRD_MSTR.cod_prod' },
  { child: 'TRX_MVR.num_cta', parent: 'CTA_MSTR.num_cta' },
  { child: 'TRX_MVR.cod_usr', parent: 'USR_SYS.cod_usr' },
  { child: 'LOG_AUT.id_trx', parent: 'TRX_MVR.id_trx' },
  { child: 'LOG_AUT.cod_usr', parent: 'USR_SYS.cod_usr' },
  { child: 'ART_MSTR.cod_prov', parent: 'PRV_MSTR.cod_prov' },
  { child: 'FAC_HDR.cod_cli', parent: 'CLI_MSTR.cod_cli' },
  { child: 'FAC_DET.num_fac', parent: 'FAC_HDR.num_fac' },
  { child: 'FAC_DET.cod_art', parent: 'ART_MSTR.cod_art' },
  { child: 'PAG_REL.cliente', parent: 'CLI_MSTR.cod_cli', hard: true }
];

// Deterministic PRNG so both engines hold identical data.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function generateRows() {
  const r = rng(42);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const pad = (n, w) => String(n).padStart(w, '0');
  const keys = {
    cli: Array.from({ length: 400 }, (_, i) => `CLI-${pad(i + 1, 4)}`),
    reg: Array.from({ length: 8 }, (_, i) => `R${i + 1}`),
    suc: Array.from({ length: 25 }, (_, i) => 100 + i),
    prod: Array.from({ length: 12 }, (_, i) => `PR-${pad(i + 1, 3)}`),
    usr: Array.from({ length: 40 }, (_, i) => `U${pad(i + 1, 4)}`),
    cta: Array.from({ length: 600 }, (_, i) => 5000 + i),
    trx: Array.from({ length: 3000 }, (_, i) => i + 1),
    prv: Array.from({ length: 30 }, (_, i) => i + 1),
    art: Array.from({ length: 150 }, (_, i) => `ART-${pad(i + 1, 5)}`),
    fac: Array.from({ length: 900 }, (_, i) => `FAC-2026-${pad(i + 1, 5)}`)
  };
  const date = () => `2026-${pad(1 + Math.floor(r() * 10), 2)}-${pad(1 + Math.floor(r() * 28), 2)}`;
  const money = () => (r() * 5000).toFixed(2);
  const out = {};
  out.CLI_MSTR = keys.cli.map((k, i) => [k, `Cliente ${i + 1}`, `${1000000 + i}-${i % 10}`, `S${1 + (i % 4)}`]);
  out.REG_CAT = keys.reg.map((k, i) => [k, `Region ${i + 1}`]);
  out.SUC_MSTR = keys.suc.map((k, i) => [k, `Sucursal ${i + 1}`, pick(keys.reg)]);
  out.PRD_MSTR = keys.prod.map((k, i) => [k, `Producto ${i + 1}`]);
  out.USR_SYS = keys.usr.map((k, i) => [k, `Usuario ${i + 1}`, pick(keys.suc), i < 5 ? null : keys.usr[Math.floor(r() * 5)]]);
  out.CTA_MSTR = keys.cta.map((k) => [k, pick(keys.cli), pick(keys.suc), pick(keys.prod), money()]);
  out.TRX_MVR = keys.trx.map((k) => [k, pick(keys.cta), pick(keys.usr), date(), money()]);
  out.LOG_AUT = Array.from({ length: 800 }, (_, i) => [i + 1, pick(keys.trx), pick(keys.usr), pick(['APROBAR', 'EDITAR', 'ANULAR'])]);
  out.PRV_MSTR = keys.prv.map((k, i) => [k, `Proveedor ${i + 1}`]);
  out.ART_MSTR = keys.art.map((k, i) => [k, `Articulo ${i + 1}`, pick(keys.prv)]);
  out.FAC_HDR = keys.fac.map((k) => [k, pick(keys.cli), date(), money()]);
  out.FAC_DET = keys.fac.flatMap((k) => {
    const n = 1 + Math.floor(r() * 5);
    return Array.from({ length: n }, (_, l) => [k, l + 1, pick(keys.art), 1 + Math.floor(r() * 9)]);
  }).slice(0, 2500);
  out.PAG_REL = Array.from({ length: 500 }, (_, i) => [i + 1, pick(keys.cli), money()]);
  out.AUX_TMP01 = Array.from({ length: 200 }, (_, i) => [i + 1, 9000 + Math.floor(r() * 50), `X-${pad(Math.floor(r() * 900), 4)}`]);
  out.CFG_PARAM = Array.from({ length: 30 }, (_, i) => [i + 1, `param_${i}`, `v${i}`]);
  out.HIST_LOTE = Array.from({ length: 100 }, (_, i) => [i + 1, 100 + (i % 20), pick(['OK', 'ERR'])]);
  return out;
}

export { pk };
