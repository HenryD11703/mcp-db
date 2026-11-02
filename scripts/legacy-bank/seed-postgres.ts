import pg from 'pg';
import { TABLES, buildDdl, generateAllRows } from './build.js';

const { Client } = pg;

async function waitForReady(config: pg.ClientConfig, attempts = 30): Promise<pg.Client> {
  for (let i = 0; i < attempts; i++) {
    const client = new Client(config);
    try {
      await client.connect();
      await client.query('SELECT 1');
      return client;
    } catch {
      try {
        await client.end();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('PostgreSQL no respondio a tiempo (banco_legado).');
}

async function main(): Promise<void> {
  const config: pg.ClientConfig = {
    host: process.env['LEGACY_BANK_PG_HOST'] ?? '127.0.0.1',
    port: Number(process.env['LEGACY_BANK_PG_PORT'] ?? 5433),
    user: 'postgres',
    password: process.env['LEGACY_BANK_PG_PASSWORD'] ?? 'legacyBank_r00t!',
    database: 'banco_legado'
  };

  console.log('[postgres] esperando a que el contenedor este listo...');
  const client = await waitForReady(config);
  console.log('[postgres] conectado. recreando esquema...');

  for (const table of TABLES.slice().reverse()) {
    await client.query(`DROP TABLE IF EXISTS "${table.name}" CASCADE`);
  }
  for (const ddl of buildDdl('postgres')) {
    await client.query(ddl);
  }
  console.log(`[postgres] ${TABLES.length} tablas creadas. insertando datos...`);

  const byTable = new Map<string, { columns: string[]; values: (string | number | null)[][] }>();
  for (const row of generateAllRows()) {
    const entry = byTable.get(row.table) ?? { columns: row.columns, values: [] };
    entry.values.push(row.values);
    byTable.set(row.table, entry);
  }

  let totalRows = 0;
  for (const [tableName, data] of byTable) {
    const colList = data.columns.join(', ');
    const chunkSize = 500;
    for (let i = 0; i < data.values.length; i += chunkSize) {
      const chunk = data.values.slice(i, i + chunkSize);
      let paramIdx = 1;
      const placeholders = chunk
        .map((row) => `(${row.map(() => `$${paramIdx++}`).join(', ')})`)
        .join(', ');
      const flat = chunk.flat();
      await client.query(`INSERT INTO "${tableName}" (${colList}) VALUES ${placeholders}`, flat);
    }
    totalRows += data.values.length;
    console.log(`[postgres]   ${tableName}: ${data.values.length} filas`);
  }

  console.log(`[postgres] listo: ${TABLES.length} tablas, ${totalRows} filas totales.`);
  await client.end();
}

main().catch((err) => {
  console.error('[postgres] ERROR:', err);
  process.exit(1);
});
