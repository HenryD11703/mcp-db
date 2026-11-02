import fs from 'node:fs';
import path from 'node:path';
import type { ReadOnlyVerificationResult } from '../../contracts/database-adapter.js';

export function verifySqlitePathAndPermissions(
  filePath: string,
  allowedDirectories: ReadonlyArray<string>
): ReadOnlyVerificationResult {
  const violations: string[] = [];
  const checkedAt = new Date().toISOString();
  const principalName = 'sqlite_process_user';

  const normalizedInput = filePath.trim().toLowerCase();
  if (
    normalizedInput === ':memory:' ||
    normalizedInput.includes('mode=memory') ||
    normalizedInput.startsWith('file::memory:')
  ) {
    violations.push('SQLite in-memory databases (:memory:) are strictly prohibited.');
  }

  if (allowedDirectories.length === 0) {
    violations.push('SQLite allowedDirectories whitelist is empty; access is denied.');
  }

  const resolvedTarget = path.resolve(filePath);

  let isInsideWhitelist = false;
  for (const allowedDir of allowedDirectories) {
    const resolvedDir = path.resolve(allowedDir);
    const relative = path.relative(resolvedDir, resolvedTarget);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      isInsideWhitelist = true;
      break;
    }
  }

  if (!isInsideWhitelist && violations.length === 0) {
    violations.push(
      `SQLite database file "${resolvedTarget}" is not located within any allowed whitelist directory: [${allowedDirectories.join(', ')}].`
    );
  }

  if (violations.length === 0) {
    try {
      if (!fs.existsSync(resolvedTarget)) {
        violations.push(`SQLite database file does not exist at "${resolvedTarget}".`);
      } else {
        fs.accessSync(resolvedTarget, fs.constants.R_OK);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      violations.push(`Failed to verify read permissions for SQLite file "${resolvedTarget}": ${msg}`);
    }
  }

  return {
    isReadOnly: violations.length === 0,
    principalName,
    checkedAt,
    sessionReadOnlyEnforced: true,
    violations
  };
}
