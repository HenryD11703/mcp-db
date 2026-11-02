import mysql from 'mysql2/promise';
import { TABLES, buildDdl, generateAllRows } from './build.js';

async function waitForReady(config: mysql.ConnectionOptions, attempts = 30): Promise<mysql.Connection> {
  for (let i = 0; i < attempts; i++) {
    try {
      const conn = await mysql.createConnection(config);
      await conn.ping();
      return conn;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('MySQL no respondio a tiempo (banco_legado).');
}

async function main(): Promise<void> {
  const config: mysql.ConnectionOptions = {
    host: process.env['LEGACY_BANK_MYSQL_HOST'] ?? '127.0.0.1',
    port: Number(process.env['LEGACY_BANK_MYSQL_PORT'] ?? 3307),
    user: 'root',
    password: process.env['LEGACY_BANK_MYSQL_ROOT_PASSWORD'] ?? 'legacyBank_r00t!',
    database: 'banco_legado',
    multipleStatements: true
  };

  console.log('[mysql] esperando a que el contenedor este listo...');
  const conn = await waitForReady(config);
  console.log('[mysql] conectado. recreando esquema...');

  for (const table of TABLES.slice().reverse()) {
    await conn.query(`DROP TABLE IF EXISTS \`${table.name}\``);
  }
  for (const ddl of buildDdl('mysql')) {
    const mysqlDdl = ddl.replace(/CREATE TABLE (\w+)/, 'CREATE TABLE `$1`').replace(/^ {2}(\w+) /gm, '  `$1` ');
    await conn.query(mysqlDdl);
  }
  console.log(`[mysql] ${TABLES.length} tablas creadas. insertando datos...`);

  const byTable = new Map<string, { columns: string[]; values: (string | number | null)[][] }>();
  for (const row of generateAllRows()) {
    const entry = byTable.get(row.table) ?? { columns: row.columns, values: [] };
    entry.values.push(row.values);
    byTable.set(row.table, entry);
  }

  let totalRows = 0;
  for (const [tableName, data] of byTable) {
    const colList = data.columns.map((c) => `\`${c}\``).join(', ');
    const chunkSize = 500;
    for (let i = 0; i < data.values.length; i += chunkSize) {
      const chunk = data.values.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => `(${data.columns.map(() => '?').join(', ')})`).join(', ');
      const flat = chunk.flat();
      await conn.query(`INSERT INTO \`${tableName}\` (${colList}) VALUES ${placeholders}`, flat);
    }
    totalRows += data.values.length;
    console.log(`[mysql]   ${tableName}: ${data.values.length} filas`);
  }

  console.log(`[mysql] listo: ${TABLES.length} tablas, ${totalRows} filas totales.`);
  await conn.end();
}

main().catch((err) => {
  console.error('[mysql] ERROR:', err);
  process.exit(1);
});
