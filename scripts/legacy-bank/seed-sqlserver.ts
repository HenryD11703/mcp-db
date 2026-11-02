import sql from 'mssql';
import { TABLES, buildDdl, generateAllRows } from './build.js';

async function waitForReady(config: sql.config, attempts = 40): Promise<sql.ConnectionPool> {
  for (let i = 0; i < attempts; i++) {
    try {
      const pool = await sql.connect(config);
      await pool.request().query('SELECT 1');
      return pool;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('SQL Server no respondio a tiempo (banco_legado).');
}

async function main(): Promise<void> {
  const config: sql.config = {
    server: process.env['LEGACY_BANK_MSSQL_HOST'] ?? '127.0.0.1',
    port: Number(process.env['LEGACY_BANK_MSSQL_PORT'] ?? 1434),
    user: 'sa',
    password: process.env['LEGACY_BANK_MSSQL_SA_PASSWORD'] ?? 'LegacyBank_r00t!2026',
    database: 'master',
    options: { trustServerCertificate: true, encrypt: false }
  };

  console.log('[sqlserver] esperando a que el contenedor este listo...');
  const pool = await waitForReady(config);
  console.log('[sqlserver] conectado. creando base banco_legado si no existe...');

  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'banco_legado')
    BEGIN
      CREATE DATABASE banco_legado;
    END
  `);
  await pool.close();

  const dbConfig: sql.config = { ...config, database: 'banco_legado' };
  const dbPool = await sql.connect(dbConfig);

  console.log('[sqlserver] recreando esquema...');
  for (const table of TABLES.slice().reverse()) {
    await dbPool.request().query(`IF OBJECT_ID('${table.name}', 'U') IS NOT NULL DROP TABLE [${table.name}]`);
  }
  for (const ddl of buildDdl('sqlserver')) {
    await dbPool.request().query(ddl);
  }
  console.log(`[sqlserver] ${TABLES.length} tablas creadas. insertando datos...`);

  const byTable = new Map<string, { columns: string[]; values: (string | number | null)[][] }>();
  for (const row of generateAllRows()) {
    const entry = byTable.get(row.table) ?? { columns: row.columns, values: [] };
    entry.values.push(row.values);
    byTable.set(row.table, entry);
  }

  let totalRows = 0;
  for (const [tableName, data] of byTable) {
    const colList = data.columns.map((c) => `[${c}]`).join(', ');
    // SQL Server caps bound params at 2100; keep chunks well under that.
    const maxParams = 1900;
    const rowsPerChunk = Math.max(1, Math.floor(maxParams / data.columns.length));
    for (let i = 0; i < data.values.length; i += rowsPerChunk) {
      const chunk = data.values.slice(i, i + rowsPerChunk);
      const request = dbPool.request();
      let paramIdx = 0;
      const rowPlaceholders: string[] = [];
      for (const row of chunk) {
        const names: string[] = [];
        for (const value of row) {
          const pname = `p${paramIdx++}`;
          request.input(pname, value as sql.ISqlTypeFactoryWithNoParams | number | string | null);
          names.push(`@${pname}`);
        }
        rowPlaceholders.push(`(${names.join(', ')})`);
      }
      // SET IDENTITY_INSERT is connection-scoped; the pool may hand out a different physical
      // connection per request(), so it must be set and cleared within this same batch/request.
      await request.query(`
        SET IDENTITY_INSERT [${tableName}] ON;
        INSERT INTO [${tableName}] (${colList}) VALUES ${rowPlaceholders.join(', ')};
        SET IDENTITY_INSERT [${tableName}] OFF;
      `);
    }
    totalRows += data.values.length;
    console.log(`[sqlserver]   ${tableName}: ${data.values.length} filas`);
  }

  console.log(`[sqlserver] listo: ${TABLES.length} tablas, ${totalRows} filas totales.`);
  await dbPool.close();
}

main().catch((err) => {
  console.error('[sqlserver] ERROR:', err);
  process.exit(1);
});
