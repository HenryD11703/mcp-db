/**
 * "Pruebas complejas" contra el banco legado simulado: valida la clasificacion
 * lexica de columnas contra el esquema completo (precision/recall), y luego
 * ejercita los adaptadores REALES del proyecto (no mocks) contra cada motor
 * sembrado para confirmar que ninguna celda sensible sale sin enmascarar.
 */
import mysql from 'mysql2/promise';
import pg from 'pg';
import sql from 'mssql';
import type { QueryParameter } from '../../src/contracts/database-adapter.js';
import { SqliteAdapter } from '../../src/adapters/sqlite/sqlite-adapter.js';
import { MySqlAdapter } from '../../src/adapters/mysql/mysql-adapter.js';
import { PostgresAdapter } from '../../src/adapters/postgres/postgres-adapter.js';
import { SqlServerAdapter, type SqlServerDriverPool, type SqlServerDriverRequest } from '../../src/adapters/sqlserver/sqlserver-adapter.js';
import type { DatabaseAdapter } from '../../src/contracts/database-adapter.js';
import { LexicalColumnAnalyzer } from '../../src/core/security/lexical-column-analyzer.js';
import { DataMaskingEngine } from '../../src/core/security/data-masking-engine.js';
import { TABLES } from './schema.js';
import { resolve } from 'node:path';

/**
 * A "leak" means the masked output still contains the full, untouched raw value
 * (not just a format that happens to look email/phone-shaped, which the masked
 * strings legitimately do -- e.g. "j***z@domain.com" is correctly masked but
 * still matches a naive email regex). So we diff masked vs. raw per cell.
 */
function findLeakedRawValue(rawValue: unknown, maskedValue: unknown): boolean {
  if (typeof rawValue !== 'string' || typeof maskedValue !== 'string') return false;
  if (rawValue.length < 4) return false; // too short to meaningfully assert on
  return maskedValue.includes(rawValue);
}

/** T-SQL has no LIMIT clause; rewrite "SELECT ... LIMIT n" to "SELECT TOP n ..." for that dialect. */
function adaptSqlForDialect(sqlText: string, dialect: string): string {
  if (dialect !== 'tsql') return sqlText;
  const match = /^SELECT\s+([\s\S]+?)\s+LIMIT\s+(\d+)\s*$/i.exec(sqlText.trim());
  if (!match) return sqlText;
  return `SELECT TOP ${match[2]} ${match[1]}`;
}

function section(title: string): void {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

// ---------------------------------------------------------------------------
// A. Precision/recall de la clasificacion lexica sobre TODO el esquema.
// ---------------------------------------------------------------------------
function validateLexicalClassification(): boolean {
  section('A. Clasificacion lexica de columnas (ground truth del esquema)');
  const analyzer = new LexicalColumnAnalyzer();
  let tp = 0, tn = 0, fp = 0, fn = 0;
  const mismatches: string[] = [];

  for (const table of TABLES) {
    for (const col of table.columns) {
      const result = analyzer.classifyColumn(col.name);
      const got = result.isSensitive;
      const want = col.expectedSensitive;
      if (got && want) tp++;
      else if (!got && !want) tn++;
      else if (got && !want) {
        fp++;
        mismatches.push(`FALSO POSITIVO: ${table.name}.${col.name} -> detectado como ${result.dataType}${col.note ? ` (${col.note})` : ''}`);
      } else {
        fn++;
        mismatches.push(`FALSO NEGATIVO: ${table.name}.${col.name} (esperado ${col.expectedType})${col.note ? ` -- ${col.note}` : ''}`);
      }
      if (got && want && col.expectedType && result.dataType !== col.expectedType) {
        mismatches.push(`TIPO INCORRECTO: ${table.name}.${col.name} -> ${result.dataType}, esperado ${col.expectedType}`);
      }
    }
  }

  const total = tp + tn + fp + fn;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  console.log(`columnas evaluadas: ${total}  (TP=${tp} TN=${tn} FP=${fp} FN=${fn})`);
  console.log(`precision=${(precision * 100).toFixed(1)}%  recall=${(recall * 100).toFixed(1)}%`);
  if (mismatches.length > 0) {
    console.log('\nDetalle:');
    for (const m of mismatches) console.log(`  - ${m}`);
  }
  // fp === 0 is the project's hard requirement (0% false positives); fn is expected for the documented gaps.
  return fp === 0;
}

// ---------------------------------------------------------------------------
// B. Ejercitar cada adaptador real contra datos sembrados.
// ---------------------------------------------------------------------------
interface EngineCheck {
  readonly label: string;
  readonly adapter: DatabaseAdapter;
}

async function runEngineChecks(check: EngineCheck): Promise<boolean> {
  section(`B. Motor real: ${check.label}`);
  const engine = new DataMaskingEngine();
  let ok = true;

  try {
    const catalog = await check.adapter.introspectSchema();
    console.log(`introspectSchema: ${catalog.tables.length} tablas detectadas.`);
    if (catalog.tables.length < TABLES.length) {
      console.log(`  ADVERTENCIA: se esperaban >= ${TABLES.length} tablas.`);
    }

    const scenarios: { label: string; sql: string; mustMaskColumns: string[] }[] = [
      {
        label: 'columnas sensibles directas (clientes)',
        sql: 'SELECT id_cliente, clinit, cli_dpi, correo_contacto, numero_telefono, monto_ingreso_mensual FROM clientes LIMIT 10',
        mustMaskColumns: ['clinit', 'cli_dpi', 'correo_contacto', 'numero_telefono', 'monto_ingreso_mensual']
      },
      {
        label: 'alias opaco sobre columna sensible (Escenario 4)',
        sql: 'SELECT clinit AS codigo_aleatorio, cli_dpi AS otro_campo FROM clientes LIMIT 10',
        mustMaskColumns: ['codigo_aleatorio', 'otro_campo']
      },
      {
        label: 'decoys de vocabulario seguro (no deben enmascararse)',
        sql: 'SELECT thumbnail_foto, monto_ingreso_mensual FROM clientes LIMIT 5',
        mustMaskColumns: ['monto_ingreso_mensual']
      },
      {
        label: 'empleados camelCase + prefijos organizacionales',
        sql: 'SELECT galempnit, emp_dpi, correoElectronico, sueldo_base FROM empleados LIMIT 10',
        mustMaskColumns: ['galempnit', 'emp_dpi', 'correoElectronico', 'sueldo_base']
      }
    ];

    for (const scenario of scenarios) {
      const sql = adaptSqlForDialect(scenario.sql, check.adapter.dialect);
      const result = await check.adapter.executeQuery({ sql, params: [] });
      const masked = engine.maskDataset(result);
      let leaked = false;
      for (let i = 0; i < result.rows.length; i++) {
        const rawRow = result.rows[i]!;
        const maskedRow = masked.rows[i]!;
        for (const colName of scenario.mustMaskColumns) {
          if (findLeakedRawValue(rawRow[colName], maskedRow[colName])) {
            leaked = true;
            console.log(`  FUGA en "${scenario.label}".${colName}: crudo="${rawRow[colName]}" enmascarado="${maskedRow[colName]}"`);
          }
        }
      }
      console.log(`  [${leaked ? 'FALLO' : 'OK'}] ${scenario.label} (${masked.maskedCellsCount} celdas enmascaradas, ${result.rowCount} filas)`);
      if (masked.rows[0]) {
        console.log(`       ejemplo: ${JSON.stringify(masked.rows[0])}`);
      }
      ok = ok && !leaked;
    }
  } catch (err) {
    console.log(`  ERROR ejecutando pruebas contra ${check.label}: ${err instanceof Error ? err.message : err}`);
    ok = false;
  } finally {
    await check.adapter.close().catch(() => {});
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Conexiones por motor (best-effort: si el contenedor no esta arriba, se omite).
// ---------------------------------------------------------------------------
async function buildSqliteAdapter(): Promise<DatabaseAdapter> {
  const filePath = resolve(process.cwd(), process.env['LEGACY_BANK_SQLITE_PATH'] ?? './data/legacy-bank/banco_legado.sqlite');
  return new SqliteAdapter({ adapterId: 'legacy-bank-sqlite', filePath, allowedDirectories: [resolve(process.cwd(), './data/legacy-bank')] });
}

async function buildMySqlAdapter(): Promise<DatabaseAdapter | null> {
  try {
    const pool = mysql.createPool({
      host: process.env['LEGACY_BANK_MYSQL_HOST'] ?? '127.0.0.1',
      port: Number(process.env['LEGACY_BANK_MYSQL_PORT'] ?? 3307),
      user: 'root',
      password: process.env['LEGACY_BANK_MYSQL_ROOT_PASSWORD'] ?? 'legacyBank_r00t!',
      database: 'banco_legado',
      connectionLimit: 5
    });
    await pool.query('SELECT 1');
    return new MySqlAdapter({ adapterId: 'legacy-bank-mysql', dialect: 'mysql', pool: pool as unknown as any });
  } catch {
    return null;
  }
}

async function buildPostgresAdapter(): Promise<DatabaseAdapter | null> {
  try {
    const config: pg.PoolConfig = {
      host: process.env['LEGACY_BANK_PG_HOST'] ?? '127.0.0.1',
      port: Number(process.env['LEGACY_BANK_PG_PORT'] ?? 5433),
      user: 'postgres',
      password: process.env['LEGACY_BANK_PG_PASSWORD'] ?? 'legacyBank_r00t!',
      database: 'banco_legado'
    };
    const probe = new pg.Pool(config);
    await probe.query('SELECT 1');
    await probe.end();
    return new PostgresAdapter('legacy-bank-postgres', config);
  } catch {
    return null;
  }
}

function sqlParamType(type: QueryParameter['type']): sql.ISqlType {
  switch (type) {
    case 'number':
      return sql.Float();
    case 'boolean':
      return sql.Bit();
    case 'date':
      return sql.DateTime2();
    default:
      return sql.NVarChar(sql.MAX);
  }
}

async function buildSqlServerAdapter(): Promise<DatabaseAdapter | null> {
  try {
    const poolConnection = await sql.connect({
      server: process.env['LEGACY_BANK_MSSQL_HOST'] ?? '127.0.0.1',
      port: Number(process.env['LEGACY_BANK_MSSQL_PORT'] ?? 1434),
      user: 'sa',
      password: process.env['LEGACY_BANK_MSSQL_SA_PASSWORD'] ?? 'LegacyBank_r00t!2026',
      database: 'banco_legado',
      options: { trustServerCertificate: true, encrypt: false }
    });
    await poolConnection.request().query('SELECT 1');

    const wrapper: SqlServerDriverPool = {
      createRequest(): SqlServerDriverRequest {
        const req = poolConnection.request();
        return {
          input(name: string, type: QueryParameter['type'], value: unknown) {
            req.input(name, sqlParamType(type), value);
          },
          async query(command: string) {
            const res = await req.query(command);
            return { recordset: res.recordset ?? [] };
          },
          cancel() {
            req.cancel();
          }
        };
      },
      async explainXml(sqlText: string) {
        const req = poolConnection.request();
        req.input('__unused', sql.NVarChar(sql.MAX), sqlText);
        const res = await poolConnection.request().query(`
          SET SHOWPLAN_XML ON;
          ${sqlText};
          SET SHOWPLAN_XML OFF;
        `);
        return (res.recordset?.[0] as any)?.['Microsoft SQL Server 2005 XML Showplan'] ?? '<plan/>';
      },
      async close() {
        await poolConnection.close();
      }
    };
    return new SqlServerAdapter('legacy-bank-mssql', wrapper);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const lexicalOk = validateLexicalClassification();

  const engineBuilders: { label: string; build: () => Promise<DatabaseAdapter | null> }[] = [
    { label: 'SQLite', build: buildSqliteAdapter },
    { label: 'MySQL', build: buildMySqlAdapter },
    { label: 'PostgreSQL', build: buildPostgresAdapter },
    { label: 'SQL Server', build: buildSqlServerAdapter }
  ];

  const results: Record<string, boolean | 'skipped'> = {};
  for (const { label, build } of engineBuilders) {
    const adapter = await build();
    if (!adapter) {
      console.log(`\n[omitido] ${label}: no se pudo conectar (contenedor no disponible o no sembrado).`);
      results[label] = 'skipped';
      continue;
    }
    results[label] = await runEngineChecks({ label, adapter });
  }

  section('Resumen final');
  console.log(`Clasificacion lexica (0% falsos positivos): ${lexicalOk ? 'OK' : 'FALLO'}`);
  for (const [label, outcome] of Object.entries(results)) {
    console.log(`${label}: ${outcome === 'skipped' ? 'omitido' : outcome ? 'OK' : 'FALLO'}`);
  }

  const anyFailure = !lexicalOk || Object.values(results).some((r) => r === false);
  process.exit(anyFailure ? 1 : 0);
}

main().catch((err) => {
  console.error('ERROR fatal en validate.ts:', err);
  process.exit(1);
});
