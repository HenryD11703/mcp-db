// Usage: node bench/build-db.mjs   (needs the bench containers; see bench/README.md)
import pg from 'pg';
import sql from 'mssql';
import { spec, DB_NAME } from './spec-select.mjs';

const { tables, generateRows } = spec;

const PG_ADMIN = process.env.BENCH_PG_ADMIN ?? 'postgresql://postgres:BenchAdmin%232026@localhost:15432/postgres';
const MS_ADMIN = process.env.BENCH_MS_ADMIN ?? 'Server=localhost,14330;User Id=sa;Password=BenchAdmin#2026!;TrustServerCertificate=true;';
const RO_PASSWORD = 'RoBench#2026';

const q = (v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const ddl = (t) =>
  `CREATE TABLE ${t.name} (${t.cols.map((c) => `${c[0]} ${c[1]}${c[2] === 'pk' ? ' NOT NULL' : ''}`).join(', ')}, PRIMARY KEY (${t.cols
    .filter((c) => c[2] === 'pk')
    .map((c) => c[0])
    .join(', ')}))`;

function* batches(rows, size) {
  for (let i = 0; i < rows.length; i += size) yield rows.slice(i, i + size);
}

async function load(exec, data) {
  for (const t of tables) {
    await exec(ddl(t));
    for (const b of batches(data[t.name], 500)) {
      await exec(`INSERT INTO ${t.name} (${t.cols.map((c) => c[0]).join(', ')}) VALUES ${b.map((r) => `(${r.map(q).join(', ')})`).join(', ')}`);
    }
  }
}

const data = generateRows();

// PostgreSQL
{
  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  const c = new pg.Client({ connectionString: PG_ADMIN.replace(/\/postgres$/, `/${DB_NAME}`) });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await load((s) => c.query(s), data);
  await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='bench_ro') THEN CREATE ROLE bench_ro LOGIN PASSWORD '${RO_PASSWORD}'; END IF; END $$`);
  await c.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO bench_ro; GRANT USAGE ON SCHEMA public TO bench_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO bench_ro; ALTER ROLE bench_ro SET default_transaction_read_only = on;`);
  await c.end();
  console.log(`postgres (${DB_NAME}): loaded`, tables.length, 'tables');
}

// SQL Server
{
  const master = await new sql.ConnectionPool(MS_ADMIN).connect();
  await master.request().query(`IF DB_ID('${DB_NAME}') IS NULL CREATE DATABASE ${DB_NAME}`);
  await master.close();
  const db = await new sql.ConnectionPool(`${MS_ADMIN}Database=${DB_NAME};`).connect();
  for (const t of [...tables].reverse()) await db.request().query(`IF OBJECT_ID('dbo.${t.name}','U') IS NOT NULL DROP TABLE dbo.${t.name}`);
  await load((s) => db.request().query(s), data);
  await db.request().query(`IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name='bench_ro') EXEC('CREATE LOGIN bench_ro WITH PASSWORD = ''${RO_PASSWORD}'', CHECK_POLICY = OFF')`);
  await db.request().query("IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name='bench_ro') CREATE USER bench_ro FOR LOGIN bench_ro");
  await db.request().query("ALTER ROLE db_datareader ADD MEMBER bench_ro");
  await db.request().query('GRANT SHOWPLAN TO bench_ro');
  await db.close();
  console.log(`sqlserver (${DB_NAME}): loaded`, tables.length, 'tables');
}
