#!/usr/bin/env node
import { MySqlAdapter } from '../adapters/mysql/index.js';
import { SqliteAdapter } from '../adapters/sqlite/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PendingApprovalStore } from '../core/limits/pending-approval-store.js';
import { AuditLogger } from '../core/audit/audit-logger.js';
import { AuditVerifier } from '../core/audit/audit-verifier.js';
import { SqlSanitizerForAudit } from '../core/audit/sql-sanitizer.js';
import { createDatabaseMcpServer, bootstrapAdapters } from '../index.js';
import { PostgresAdapter, createNodePostgresDriverPool } from '../adapters/postgres/postgres-adapter.js';
import { SqlServerAdapter, createMssqlDriverPool } from '../adapters/sqlserver/sqlserver-adapter.js';
import type { DatabaseAdapter } from '../contracts/database-adapter.js';
import * as readline from 'node:readline/promises';
import { runInteractiveInstaller } from './installer.js';
import {
  defaultConfigPath,
  isConnectionType,
  loadConfig,
  redactConnectionString,
  removeConnection,
  resolveConfigPath,
  upsertConnection,
  type ConnectionEntry
} from './config-store.js';
import { isMainModule } from './is-main.js';
import { createShutdown } from './shutdown.js';
import { quoteIdentifier } from '../core/discovery/containment-sql.js';

export function resolveDefaultAuditLogPath(): string {
  if (process.env['AUDIT_LOG_PATH']) {
    return process.env['AUDIT_LOG_PATH'];
  }
  const cwdAudit = resolve(process.cwd(), 'audit.jsonl');
  if (existsSync(cwdAudit)) {
    return cwdAudit;
  }
  return join(homedir(), '.db-mcp', 'audit.jsonl');
}

/** Explains why plan analysis failed and, for the common SQL Server case, the exact grant that fixes it. */
export function planAnalysisHint(type: string, message: string): string {
  if (type === 'sqlserver' && /showplan/i.test(message) && /permission|denied/i.test(message)) {
    return 'el usuario no tiene permiso SHOWPLAN. Como administrador ejecute: GRANT SHOWPLAN TO <usuario>;';
  }
  if ((type === 'mysql' || type === 'mariadb') && /explain/i.test(message)) {
    return `verifique permisos de SELECT y sintaxis EXPLAIN (${message}).`;
  }
  if (type === 'sqlite') {
    return `error al analizar el plan con EXPLAIN QUERY PLAN (${message}).`;
  }
  return `no se pudo analizar el plan de ejecución (${message}).`;
}

export async function buildAdapter(entry: ConnectionEntry & { config?: unknown }): Promise<DatabaseAdapter> {
  const connStr = entry.connectionString || (typeof entry.config === 'string' ? entry.config : '');
  if (entry.type === 'postgres') {
    const pool = createNodePostgresDriverPool({ connectionString: connStr });
    return new PostgresAdapter(entry.id || 'postgres', pool);
  }
  if (entry.type === 'sqlserver') {
    const pool = await createMssqlDriverPool(connStr);
    return new SqlServerAdapter(entry.id || 'sqlserver', pool);
  }
  if (entry.type === 'mysql' || entry.type === 'mariadb') {
    return new MySqlAdapter({
      adapterId: entry.id || 'mysql',
      dialect: entry.type === 'mariadb' ? 'mariadb' : 'mysql',
      connectionConfig: connStr
    });
  }
  if (entry.type === 'sqlite') {
    const rawAllowed = process.env['SQLITE_ALLOWED_DIRECTORIES'];
    const allowedDirs = rawAllowed
      ? rawAllowed.split(',').map((d) => resolve(d.trim())).filter((d) => d.length > 0)
      : [process.cwd(), resolve(connStr, '..')];
    return new SqliteAdapter({
      adapterId: entry.id || 'sqlite',
      filePath: connStr,
      allowedDirectories: allowedDirs
    });
  }
  throw new Error(`Tipo de conexión no soportado: "${String((entry as { type?: unknown }).type)}" (id: ${entry.id}).`);
}

/** Priority: --config / MCP_CONFIG_PATH file, then POSTGRES_URL / SQLSERVER_URL env, then ~/.db-mcp/config.json. */
export async function loadAdapters(args: ReadonlyArray<string>): Promise<DatabaseAdapter[]> {
  const configIdx = args.indexOf('--config');
  const explicit = configIdx !== -1 ? args[configIdx + 1] : process.env['MCP_CONFIG_PATH'];
  const adapters: DatabaseAdapter[] = [];

  if (explicit) {
    const path = resolveConfigPath(explicit);
    if (!existsSync(path)) {
      throw new Error(`No existe el archivo de configuración "${path}".`);
    }
    for (const entry of loadConfig(path).adapters) {
      adapters.push(await buildAdapter(entry));
    }
    return adapters;
  }

  const pgUrl = process.env['POSTGRES_URL'] || process.env['PG_URL'];
  if (pgUrl) {
    adapters.push(await buildAdapter({ id: process.env['PG_ADAPTER_ID'] || 'postgres', type: 'postgres', connectionString: pgUrl }));
  }
  const mssqlUrl = process.env['SQLSERVER_URL'] || process.env['MSSQL_URL'];
  if (mssqlUrl) {
    adapters.push(await buildAdapter({ id: process.env['MSSQL_ADAPTER_ID'] || 'sqlserver', type: 'sqlserver', connectionString: mssqlUrl }));
  }
  const mysqlUrl = process.env['MYSQL_URL'] || process.env['MYSQL_URI'];
  if (mysqlUrl) {
    adapters.push(await buildAdapter({ id: process.env['MYSQL_ADAPTER_ID'] || 'mysql', type: 'mysql', connectionString: mysqlUrl }));
  }
  const sqlitePath = process.env['SQLITE_PATH'] || process.env['SQLITE_URL'];
  if (sqlitePath) {
    adapters.push(await buildAdapter({ id: process.env['SQLITE_ADAPTER_ID'] || 'sqlite', type: 'sqlite', connectionString: sqlitePath }));
  }
  if (adapters.length > 0) {
    return adapters;
  }

  for (const entry of loadConfig(defaultConfigPath()).adapters) {
    adapters.push(await buildAdapter(entry));
  }
  return adapters;
}

async function handleConnectionCommands(command: string, args: ReadonlyArray<string>): Promise<number> {
  const flag = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const configPath = resolveConfigPath(flag('--config'));

  try {
    if (command === 'add') {
      const id = args[1];
      const type = flag('--type');
      let url = flag('--url');
      if (!id || id.startsWith('--') || !type) {
        console.error('Uso: db-mcp add <id> --type postgres|sqlserver|mysql|mariadb|sqlite [--url <cadena>]');
        return 1;
      }
      if (!isConnectionType(type)) {
        console.error(`Tipo inválido "${type}": use "postgres", "sqlserver", "mysql", "mariadb" o "sqlite".`);
        return 1;
      }
      if (!url) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        try {
          url = (await rl.question('Cadena de conexión:\n> ')).trim();
        } finally {
          rl.close();
        }
      }
      const { replaced } = upsertConnection(configPath, { id, type, connectionString: url });
      console.log(`[DB-MCP] Conexión "${id}" (${type}) ${replaced ? 'actualizada' : 'agregada'} en ${configPath}`);
      console.log(`Pruébela con: db-mcp test ${id}`);
      return 0;
    }

    if (command === 'remove') {
      const id = args[1];
      if (!id) {
        console.error('Uso: db-mcp remove <id>');
        return 1;
      }
      if (!removeConnection(configPath, id)) {
        console.error(`[DB-MCP ERROR] No existe la conexión "${id}" en ${configPath}.`);
        return 1;
      }
      console.log(`[DB-MCP] Conexión "${id}" eliminada.`);
      return 0;
    }

    if (command === 'connections') {
      const { adapters } = loadConfig(configPath);
      if (adapters.length === 0) {
        console.log(`[DB-MCP] No hay conexiones en ${configPath}. Use "db-mcp add".`);
        return 0;
      }
      console.log(`[DB-MCP] Conexiones en ${configPath}:`);
      for (const a of adapters) {
        console.log(`  - ${a.id} (${a.type}): ${redactConnectionString(a.connectionString)}`);
      }
      return 0;
    }

    // test [id] / doctor: connect and run the startup preflight (read-only enforcement) per connection.
    let failed = 0;
    let warned = 0;

    if (command === 'doctor') {
      console.log('=== DB-MCP DOCTOR: Diagnóstico del Sistema ===\n');
      const major = parseInt(process.versions.node.split('.')[0] || '0', 10);
      if (major >= 20) {
        console.log(`✓ Node.js: v${process.versions.node} (compatible con Node.js 20+)`);
      } else {
        console.error(`✗ Node.js: v${process.versions.node} (requiere Node.js 20 o superior)`);
        failed++;
      }

      console.log(`✓ Configuración: ${configPath} (${existsSync(configPath) ? 'encontrado' : 'no existe aún'})`);

      const auditPath = resolveDefaultAuditLogPath();
      if (existsSync(auditPath)) {
        try {
          const verifier = new AuditVerifier();
          const auditRes = await verifier.verifyLogFile(auditPath);
          if (auditRes.isValid) {
            console.log(`✓ Auditoría: cadena criptográfica intacta (${auditRes.totalEntries} entradas) en ${auditPath}`);
          } else {
            console.warn(`⚠ Auditoría: cadena con inconsistencia en ${auditPath} (${auditRes.violatedEntry?.reason})`);
            warned++;
          }
        } catch (auditErr) {
          console.warn(`⚠ Auditoría: error al verificar cadena (${auditErr instanceof Error ? auditErr.message : auditErr})`);
          warned++;
        }
      } else {
        console.log(`- Auditoría: archivo aún no generado (${auditPath})`);
      }
      console.log('');
    }

    const wanted = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
    const entries = loadConfig(configPath).adapters.filter((a) => !wanted || a.id === wanted);
    if (entries.length === 0) {
      console.error(wanted ? `[DB-MCP ERROR] No existe la conexión "${wanted}".` : '[DB-MCP ERROR] No hay conexiones configuradas.');
      return 1;
    }
    for (const entry of entries) {
      let adapter: DatabaseAdapter | undefined;
      try {
        adapter = await buildAdapter(entry);
        await bootstrapAdapters([adapter]);
        console.log(`✓ ${entry.id} (${entry.type}): conexión y preflight de solo lectura OK`);
        // Cost gating needs EXPLAIN/SHOWPLAN. Without it every query is quarantined (fail-safe), which is easy to miss.
        try {
          // The permission is only enforced on user objects (catalog views and SELECT 1 pass without it),
          // so probe with the first user table found.
          const catalog = await adapter.introspectSchema();
          const target = catalog.tables.find((t) => t.kind === 'TABLE');
          if (!target) {
            console.log(`- ${entry.id}: sin tablas de usuario; no se pudo comprobar el análisis de plan`);
          } else {
            const dialect = adapter.dialect;
            const q = (id: string): string => quoteIdentifier(dialect, id);
            const from = `${q(target.schema)}.${q(target.name)}`;
            const probeSql = dialect === 'tsql' ? `SELECT TOP (1) * FROM ${from}` : `SELECT * FROM ${from} LIMIT 1`;
            await adapter.analyzeQueryPlan({ sql: probeSql, params: [] });
            console.log(`✓ ${entry.id}: análisis de plan de ejecución disponible`);
          }
        } catch (planErr) {
          warned++;
          console.error(`⚠ ${entry.id}: ${planAnalysisHint(entry.type, planErr instanceof Error ? planErr.message : String(planErr))}`);
        }
      } catch (err) {
        failed++;
        console.error(`✗ ${entry.id} (${entry.type}): ${err instanceof Error ? err.message : err}`);
      } finally {
        await adapter?.close().catch(() => undefined);
      }
    }
    if (warned > 0) {
      console.error('\nAdvertencia: sin análisis de plan, las consultas quedan en PENDING_APPROVAL hasta que un operador las apruebe.');
    }
    if (command === 'doctor') {
      console.log('\n---------------------------------------------');
      if (failed === 0) {
        console.log('✓ Diagnóstico completado sin errores críticos.');
      } else {
        console.error(`✗ Diagnóstico completado con ${failed} error(es).`);
      }
    }
    return failed === 0 ? 0 : 1;
  } catch (err) {
    console.error('[DB-MCP ERROR]', err instanceof Error ? err.message : err);
    return 1;
  }
}

export async function handleCli(args: ReadonlyArray<string>): Promise<number> {
  const command = args[0]?.toLowerCase();

  if (command === 'install' || command === 'configure' || command === 'init') {
    return await runInteractiveInstaller(args.slice(1));
  }

  if (command === 'add' || command === 'remove' || command === 'connections' || command === 'test' || command === 'doctor') {
    return await handleConnectionCommands(command, args);
  }

  const store = new PendingApprovalStore();
  const resolvedAuditPath = resolveDefaultAuditLogPath();
  const auditLogger = new AuditLogger({
    logFilePath: resolvedAuditPath
  });
  const sanitizer = new SqlSanitizerForAudit();

  const isAutoStart =
    !command &&
    Boolean(
      process.env['POSTGRES_URL'] ||
      process.env['PG_URL'] ||
      process.env['SQLSERVER_URL'] ||
      process.env['MSSQL_URL'] ||
      process.env['MYSQL_URL'] ||
      process.env['MYSQL_URI'] ||
      process.env['SQLITE_PATH'] ||
      process.env['SQLITE_URL'] ||
      process.env['MCP_CONFIG_PATH']
    );

  if (command === 'start' || command === 'serve' || isAutoStart) {
    let adapters: DatabaseAdapter[];
    try {
      adapters = await loadAdapters(args);
    } catch (err) {
      console.error('[DB-MCP ERROR]', err instanceof Error ? err.message : err);
      return 1;
    }

    if (adapters.length === 0) {
      console.error(
        '[DB-MCP ERROR] No se configuraron adaptadores de base de datos.\n' +
        `Ejecute "db-mcp add <id> --type postgres|sqlserver --url <cadena>" (se guarda en ${defaultConfigPath()}), ` +
        'defina POSTGRES_URL / SQLSERVER_URL / MYSQL_URL / SQLITE_PATH o use --config <archivo.json>.'
      );
      return 1;
    }

    try {
      console.error(`[DB-MCP] Inicializando ${adapters.length} adaptador(es) con preflight gate...`);
      const registry = await bootstrapAdapters(adapters);
      const outputFormat = process.env['MCP_OUTPUT_FORMAT'];
      if (outputFormat !== undefined && outputFormat !== 'semantic_xml' && outputFormat !== 'strict_json') {
        console.error('[DB-MCP ERROR] MCP_OUTPUT_FORMAT debe ser "semantic_xml" o "strict_json".');
        return 1;
      }
      const server = createDatabaseMcpServer(registry, {
        ...(outputFormat ? { defaultOutputFormat: outputFormat } : {}),
        auditLogger,
        auditLogPath: resolvedAuditPath,
        approvalStore: store
      });

      const transport = new StdioServerTransport();

      const shutdown = createShutdown({
        closeServer: () => server.close(),
        closeAdapters: () => registry.closeAll(),
        exit: (code) => process.exit(code)
      });

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      // The client going away is seen as the end of stdin; the SDK transport does not watch for it.
      process.stdin.on('end', () => void shutdown());
      transport.onclose = () => void shutdown();

      await server.connect(transport);
      console.error('[DB-MCP] Servidor MCP conectado exitosamente sobre Stdio.');
      return new Promise<number>(() => {}); // Keep alive
    } catch (err) {
      console.error('[DB-MCP ERROR] Fallo al iniciar servidor MCP:', err instanceof Error ? err.message : err);
      return 1;
    }
  }

  if (command === 'list-pending' || command === 'list') {
    const pending = await store.listPendingTickets();
    if (pending.length === 0) {
      console.log('[DB-MCP] No hay consultas pendientes de aprobación.');
      return 0;
    }

    console.log(`[DB-MCP] Consultas pendientes de aprobación (${pending.length}):\n`);
    for (const ticket of pending) {
      console.log(`- ID de Aprobación: ${ticket.approvalId}`);
      console.log(`  Motor: ${ticket.engine} | Base de datos: ${ticket.database}`);
      console.log(`  Solicitante: ${ticket.requesterId} | Correlación: ${ticket.correlationId}`);
      console.log(`  Creado: ${ticket.createdAt} | Expira: ${ticket.expiresAt}`);
      console.log(`  Riesgo: ${ticket.riskProfile.severity} (Filas est: ${ticket.riskProfile.estimatedRows}, Costo est: ${ticket.riskProfile.estimatedCost})`);
      if (ticket.riskProfile.warnings.length > 0) {
        console.log(`  Advertencias: ${ticket.riskProfile.warnings.join('; ')}`);
      }
      console.log(`  SQL: ${ticket.sql}\n`);
    }
    return 0;
  }

  if (command === 'approve' || command === 'reject') {
    let rawApprovalId = args[1]?.replace(/['"]/g, '').trim();
    const pending = await store.listPendingTickets();

    if (!rawApprovalId || rawApprovalId === 'latest') {
      if (pending.length === 0) {
        console.log(`[DB-MCP] No hay consultas pendientes de aprobación.`);
        return 0;
      }

      if (pending.length === 1 || rawApprovalId === 'latest') {
        const target = pending[pending.length - 1]!;
        rawApprovalId = target.approvalId;
        console.log(`[DB-MCP] Seleccionando consulta pendiente: ${rawApprovalId}`);
      } else {
        console.log(`[DB-MCP] Hay ${pending.length} consultas pendientes de aprobación:\n`);
        pending.forEach((t, i) => {
          console.log(`  [${i + 1}] ${t.approvalId}`);
          console.log(`      Base de datos: ${t.database} | Creado: ${t.createdAt}`);
          console.log(`      SQL: ${t.sql.replace(/\s+/g, ' ').slice(0, 120)}...\n`);
        });
        console.log(`Para aprobar una, ejecuta:`);
        console.log(`  npm run cli:db-mcp approve <approvalId>`);
        console.log(`  npm run cli:db-mcp approve latest`);
        return 0;
      }
    }

    let reason: string | undefined;
    const reasonIndex = args.indexOf('--reason');
    if (reasonIndex !== -1 && args[reasonIndex + 1]) {
      reason = args[reasonIndex + 1];
    }

    const operator = process.env['MCP_OPERATOR_NAME'] || process.env['USER'] || process.env['USERNAME'] || 'operador_humano';
    const decision = command === 'approve' ? 'APPROVED' : 'REJECTED';

    try {
      const ticket = await store.getTicket(rawApprovalId);
      if (!ticket) {
        console.error(`[DB-MCP ERROR] No se encontró ningún ticket que coincida con "${rawApprovalId}".`);
        if (pending.length > 0) {
          console.error(`\nTickets pendientes disponibles:`);
          for (const t of pending) {
            console.error(`  - ${t.approvalId} (Base de datos: ${t.database}, Creado: ${t.createdAt})`);
          }
        }
        return 1;
      }

      const resolved = await store.resolveTicket(ticket.approvalId, decision, operator, reason);

      // Audit decision
      await auditLogger.logEvent({
        correlationId: ticket.correlationId,
        requesterId: operator,
        timestamp: new Date().toISOString(),
        engine: ticket.engine,
        database: ticket.database,
        evaluatedSql: sanitizer.sanitizeSqlForAudit(ticket.sql),
        status: decision === 'APPROVED' ? 'EXECUTED' : 'REJECTED_BY_GUARD',
        rejectionReason: decision === 'REJECTED' ? (reason || 'Rechazado por operador humano.') : null,
        executionTimeMs: 0,
        rowCount: 0
      });

      console.log(`[DB-MCP SUCCESS] Consulta ${ticket.approvalId} resuelta como ${decision}.`);
      console.log(`Operador: ${resolved.resolvedBy}`);
      if (reason) {
        console.log(`Motivo: ${reason}`);
      }
      return 0;
    } catch (err: unknown) {
      console.error(`[DB-MCP ERROR] Fallo al procesar ticket:`, err instanceof Error ? err.message : err);
      return 1;
    }
  }

  console.log(`Uso de CLI db-mcp:`);
  console.log(`  db-mcp install               (Asistente interactivo de instalación en Agy, Claude Code, etc.)`);
  console.log(`  db-mcp start [--config <cfg>] (Inicia el servidor MCP sobre Stdio)`);
  console.log(`  db-mcp add <id> --type postgres|sqlserver [--url <cadena>]  (Guarda una conexión en ~/.db-mcp/config.json)`);
  console.log(`  db-mcp connections           (Lista conexiones, con contraseñas ocultas)`);
  console.log(`  db-mcp test [id]             (Prueba conexión y preflight de solo lectura)`);
  console.log(`  db-mcp remove <id>           (Elimina una conexión)`);
  console.log(`  db-mcp list-pending          (Lista consultas en cuarentena)`);
  console.log(`  db-mcp approve [approvalId]  (Aprueba consulta retenida o la más reciente)`);
  console.log(`  db-mcp reject [approvalId]   (Rechaza consulta retenida o la más reciente)`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  handleCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
