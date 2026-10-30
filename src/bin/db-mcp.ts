import { PendingApprovalStore } from '../core/limits/pending-approval-store.js';
import { AuditLogger } from '../core/audit/audit-logger.js';
import { SqlSanitizerForAudit } from '../core/audit/sql-sanitizer.js';

export async function handleCli(args: ReadonlyArray<string>): Promise<number> {
  const command = args[0]?.toLowerCase();
  const store = new PendingApprovalStore();
  const auditLogger = new AuditLogger({
    logFilePath: process.env['AUDIT_LOG_PATH'] || 'audit.jsonl'
  });
  const sanitizer = new SqlSanitizerForAudit();

  if (command === 'list-pending') {
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
