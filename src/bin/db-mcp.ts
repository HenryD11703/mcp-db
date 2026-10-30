import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PendingApprovalStore } from '../core/limits/pending-approval-store.js';
import { AuditLogger } from '../core/audit/audit-logger.js';
import { SqlSanitizerForAudit } from '../core/audit/sql-sanitizer.js';
import { createDatabaseMcpServer, bootstrapAdapters } from '../index.js';
import { PostgresAdapter, createNodePostgresDriverPool } from '../adapters/postgres/postgres-adapter.js';
import { SqlServerAdapter, createMssqlDriverPool } from '../adapters/sqlserver/sqlserver-adapter.js';
import type { DatabaseAdapter } from '../contracts/database-adapter.js';

export async function handleCli(args: ReadonlyArray<string>): Promise<number> {
  const command = args[0]?.toLowerCase();
  const store = new PendingApprovalStore();
  const auditLogger = new AuditLogger({
    logFilePath: process.env['AUDIT_LOG_PATH'] || 'audit.jsonl'
  });
  const sanitizer = new SqlSanitizerForAudit();

  const isAutoStart =
    !command &&
    Boolean(
      process.env['POSTGRES_URL'] ||
      process.env['PG_URL'] ||
      process.env['SQLSERVER_URL'] ||
      process.env['MSSQL_URL'] ||
      process.env['MCP_CONFIG_PATH']
    );

  if (command === 'start' || command === 'serve' || isAutoStart) {
    const configIdx = args.indexOf('--config');
    const configPath = configIdx !== -1 ? args[configIdx + 1] : process.env['MCP_CONFIG_PATH'];
    const adapters: DatabaseAdapter[] = [];

    if (configPath && existsSync(resolve(process.cwd(), configPath))) {
      try {
        const raw = readFileSync(resolve(process.cwd(), configPath), 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.adapters)) {
          for (const item of parsed.adapters) {
            if (item.type === 'postgres') {
              const pool = createNodePostgresDriverPool({ connectionString: item.connectionString });
              adapters.push(new PostgresAdapter(item.id || 'postgres', pool));
            } else if (item.type === 'sqlserver') {
              const pool = await createMssqlDriverPool(item.connectionString || item.config);
              adapters.push(new SqlServerAdapter(item.id || 'sqlserver', pool));
            }
          }
        }
      } catch (err) {
        console.error(`[DB-MCP ERROR] Error al cargar archivo de configuración "${configPath}":`, err);
        return 1;
      }
    } else {
      const pgUrl = process.env['POSTGRES_URL'] || process.env['PG_URL'];
      if (pgUrl) {
        const pool = createNodePostgresDriverPool({ connectionString: pgUrl });
        const adapterId = process.env['PG_ADAPTER_ID'] || 'postgres';
        adapters.push(new PostgresAdapter(adapterId, pool));
      }

      const mssqlUrl = process.env['SQLSERVER_URL'] || process.env['MSSQL_URL'];
      if (mssqlUrl) {
        const pool = await createMssqlDriverPool(mssqlUrl);
        const adapterId = process.env['MSSQL_ADAPTER_ID'] || 'sqlserver';
        adapters.push(new SqlServerAdapter(adapterId, pool));
      }
    }

    if (adapters.length === 0) {
      console.error(
        '[DB-MCP ERROR] No se configuraron adaptadores de base de datos.\n' +
        'Defina POSTGRES_URL / SQLSERVER_URL en variables de entorno o use --config <archivo.json>.'
      );
      return 1;
    }

    try {
      console.error(`[DB-MCP] Inicializando ${adapters.length} adaptador(es) con preflight gate...`);
      const registry = await bootstrapAdapters(adapters);
      const server = createDatabaseMcpServer(registry);

      const transport = new StdioServerTransport();
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
    const approvalId = args[1];
    if (!approvalId) {
      console.error(`[DB-MCP ERROR] Debe especificar el identificador de aprobación: db-mcp ${command} <approvalId>`);
      return 1;
    }

    let reason: string | undefined;
    const reasonIndex = args.indexOf('--reason');
    if (reasonIndex !== -1 && args[reasonIndex + 1]) {
      reason = args[reasonIndex + 1];
    }

    const operator = process.env['MCP_OPERATOR_NAME'] || process.env['USER'] || process.env['USERNAME'] || 'operador_humano';
    const decision = command === 'approve' ? 'APPROVED' : 'REJECTED';

    try {
      const ticket = await store.getTicket(approvalId);
      if (!ticket) {
        console.error(`[DB-MCP ERROR] No se encontró ningún ticket con ID "${approvalId}".`);
        return 1;
      }

      const resolved = await store.resolveTicket(approvalId, decision, operator, reason);

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

      console.log(`[DB-MCP SUCCESS] Consulta ${approvalId} resuelta como ${decision}.`);
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
  console.log(`  db-mcp start [--config <archivo.json>]`);
  console.log(`  db-mcp list-pending`);
  console.log(`  db-mcp approve <approvalId> [--reason <texto>]`);
  console.log(`  db-mcp reject <approvalId> [--reason <texto>]`);
  return 0;
}

if (process.argv[1]?.endsWith('db-mcp.ts') || process.argv[1]?.endsWith('db-mcp.js')) {
  handleCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
