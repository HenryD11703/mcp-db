import type { ReadOnlyVerificationResult } from '../../contracts/database-adapter.js';

/**
 * Privileges that let a session change data, structure or server state, or that read outside the
 * database (FILE) or block other sessions (LOCK TABLES). Matched against the exact CURRENT_USER()
 * account ('user'@'host'), not only the user name.
 */
const WRITE_PRIVILEGES = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'GRANT OPTION',
  'TRIGGER',
  'EVENT',
  'LOCK TABLES',
  'CREATE TEMPORARY TABLES',
  'CREATE VIEW',
  'CREATE ROUTINE',
  'ALTER ROUTINE',
  'REFERENCES'
]
  .map((p) => `'${p}'`)
  .join(', ');

const GLOBAL_ONLY_PRIVILEGES = ["'SUPER'", "'FILE'", "'ALL PRIVILEGES'", "'SHUTDOWN'", "'RELOAD'"].join(', ');

const CURRENT_ACCOUNT =
  `CONCAT("'", SUBSTRING_INDEX(CURRENT_USER(), '@', 1), "'@'", SUBSTRING_INDEX(CURRENT_USER(), '@', -1), "'")`;

export const MYSQL_PREFLIGHT_QUERY = `
  SELECT 
    CURRENT_USER() AS principal_name,
    DATABASE() AS database_name,
    EXISTS (
      SELECT 1 FROM information_schema.user_privileges
      WHERE PRIVILEGE_TYPE IN (${WRITE_PRIVILEGES}, ${GLOBAL_ONLY_PRIVILEGES})
        AND GRANTEE = ${CURRENT_ACCOUNT}
    ) AS has_global_write,
    EXISTS (
      SELECT 1 FROM information_schema.schema_privileges
      WHERE PRIVILEGE_TYPE IN (${WRITE_PRIVILEGES})
        AND GRANTEE = ${CURRENT_ACCOUNT}
    ) AS has_schema_write,
    EXISTS (
      SELECT 1 FROM information_schema.table_privileges
      WHERE PRIVILEGE_TYPE IN (${WRITE_PRIVILEGES})
        AND GRANTEE = ${CURRENT_ACCOUNT}
    ) AS has_table_write
`;

export interface MySqlPreflightRow {
  principal_name?: string;
  database_name?: string;
  has_global_write?: number | boolean;
  has_schema_write?: number | boolean;
  has_table_write?: number | boolean;
}

export function evaluateMySqlPreflight(row: MySqlPreflightRow | undefined): ReadOnlyVerificationResult {
  const violations: string[] = [];
  const checkedAt = new Date().toISOString();
  const principalName = row?.principal_name ?? 'unknown_mysql_user';

  if (!row) {
    return {
      isReadOnly: false,
      principalName,
      checkedAt,
      sessionReadOnlyEnforced: true,
      violations: ['Failed to retrieve user privileges from information_schema.']
    };
  }

  if (Boolean(row.has_global_write)) {
    violations.push(`MySQL user '${principalName}' holds global mutating privileges (user_privileges).`);
  }
  if (Boolean(row.has_schema_write)) {
    violations.push(`MySQL user '${principalName}' holds schema mutating privileges (schema_privileges).`);
  }
  if (Boolean(row.has_table_write)) {
    violations.push(`MySQL user '${principalName}' holds table mutating privileges (table_privileges).`);
  }

  return {
    isReadOnly: violations.length === 0,
    principalName,
    checkedAt,
    sessionReadOnlyEnforced: true,
    violations
  };
}
