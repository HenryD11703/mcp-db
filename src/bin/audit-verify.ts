#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuditVerifier } from '../core/audit/audit-verifier.js';

function resolveAuditTarget(explicitArg?: string): string {
  if (explicitArg) {
    return resolve(process.cwd(), explicitArg);
  }
  if (process.env['AUDIT_LOG_PATH']) {
    return resolve(process.cwd(), process.env['AUDIT_LOG_PATH']);
  }
  const cwdAudit = resolve(process.cwd(), 'audit.jsonl');
  if (existsSync(cwdAudit)) {
    return cwdAudit;
  }
  return join(homedir(), '.db-mcp', 'audit.jsonl');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const resolvedPath = resolveAuditTarget(args[0]);

  console.log(`[AUDIT-VERIFY] Verifying audit log integrity: ${resolvedPath}`);

  const verifier = new AuditVerifier();
  const result = await verifier.verifyLogFile(resolvedPath);

  if (result.isValid) {
    console.log(
      `[AUDIT-VERIFY SUCCESS] Chain intact. ${result.totalEntries} entries verified.`
    );
    console.log(
      `Sequence range: #${result.firstSequenceNumber} -> #${result.lastSequenceNumber}`
    );
    process.exit(0);
  } else {
    console.error(
      `[AUDIT-VERIFY FAILED] Chain broken! Reason: ${result.violatedEntry?.reason}`
    );
    if (result.violatedEntry) {
      console.error(
        `At line ${result.violatedEntry.lineNumber} (Sequence #${result.violatedEntry.sequenceNumber}, Correlation: ${result.violatedEntry.correlationId})`
      );
      if (result.violatedEntry.expectedHash) {
        console.error(`Expected: ${result.violatedEntry.expectedHash}`);
        console.error(`Actual:   ${result.violatedEntry.actualHash}`);
      }
      if (result.violatedEntry.rawLine) {
        console.error(`Raw line: ${result.violatedEntry.rawLine.slice(0, 120)}...`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[AUDIT-VERIFY ERROR]', err);
  process.exit(1);
});
