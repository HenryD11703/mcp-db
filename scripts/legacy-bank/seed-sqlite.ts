import Database from 'better-sqlite3';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TABLES, buildDdl, generateAllRows } from './build.js';

const OUT_PATH = resolve(process.cwd(), process.env['LEGACY_BANK_SQLITE_PATH'] ?? './data/legacy-bank/banco_legado.sqlite');

function main(): void {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  if (existsSync(OUT_PATH)) {
    unlinkSync(OUT_PATH);
  }

  console.log(`[sqlite] creando ${OUT_PATH} ...`);
  const db = new Database(OUT_PATH);
  db.pragma('journal_mode = WAL');

  for (const ddl of buildDdl('sqlite')) {
    db.exec(ddl + ';');
  }
  console.log(`[sqlite] ${TABLES.length} tablas creadas. insertando datos...`);

  const byTable = new Map<string, { columns: string[]; values: (string | number | null)[][] }>();
  for (const row of generateAllRows()) {
    const entry = byTable.get(row.table) ?? { columns: row.columns, values: [] };
    entry.values.push(row.values);
    byTable.set(row.table, entry);
  }

  let totalRows = 0;
  for (const [tableName, data] of byTable) {
    const colList = data.columns.join(', ');
    const placeholders = data.columns.map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`);
    const insertMany = db.transaction((rows: (string | number | null)[][]) => {
      for (const row of rows) stmt.run(...row);
    });
    insertMany(data.values);
    totalRows += data.values.length;
    console.log(`[sqlite]   ${tableName}: ${data.values.length} filas`);
  }

  db.close();
  console.log(`[sqlite] listo: ${TABLES.length} tablas, ${totalRows} filas totales -> ${OUT_PATH}`);
}

main();
