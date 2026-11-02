import type { SqlValidationResult } from '../../contracts/database-adapter.js';

const SAFE_PRAGMAS = new Set([
  'table_info',
  'foreign_key_list',
  'database_list',
  'table_xinfo',
  'index_list',
  'index_info'
]);

export function validateSqlitePragma(sql: string): SqlValidationResult {
  const trimmed = sql.trim();
  const pragmaMatch = trimmed.match(/^PRAGMA\s+([a-zA-Z_][\w]*)/i);
  if (!pragmaMatch) {
    return { allowed: true };
  }

  const pragmaName = pragmaMatch[1]!.toLowerCase();
  if (!SAFE_PRAGMAS.has(pragmaName)) {
    return {
      allowed: false,
      reasonCode: 'V10_SESSION_OR_INTERNAL_CMD',
      message: `SQLite PRAGMA "${pragmaName}" is prohibited. Only schema read pragmas are permitted.`
    };
  }

  // Prevent mutating PRAGMA assignments (e.g., PRAGMA journal_mode = WAL)
  if (trimmed.includes('=')) {
    return {
      allowed: false,
      reasonCode: 'V10_SESSION_OR_INTERNAL_CMD',
      message: 'Mutating PRAGMA configuration assignments are strictly prohibited.'
    };
  }

  return { allowed: true };
}
