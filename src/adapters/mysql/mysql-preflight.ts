import type { ReadOnlyVerificationResult } from '../../contracts/database-adapter.js';

export const MYSQL_PREFLIGHT_QUERY = `
  SELECT 
    CURRENT_USER() AS principal_name,
    DATABASE() AS database_name,
    EXISTS (
      SELECT 1 FROM information_schema.user_privileges
      WHERE PRIVILEGE_TYPE IN ('INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'SUPER', 'ALL PRIVILEGES', 'GRANT OPTION')
        AND GRANTEE LIKE CONCAT("'", SUBSTRING_INDEX(CURRENT_USER(), '@', 1), "'%")
    ) AS has_global_write,
    EXISTS (
      SELECT 1 FROM information_schema.schema_privileges
      WHERE PRIVILEGE_TYPE IN ('INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'GRANT OPTION')
        AND GRANTEE LIKE CONCAT("'", SUBSTRING_INDEX(CURRENT_USER(), '@', 1), "'%")
    ) AS has_schema_write,
    EXISTS (
      SELECT 1 FROM information_schema.table_privileges
      WHERE PRIVILEGE_TYPE IN ('INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'GRANT OPTION')
        AND GRANTEE LIKE CONCAT("'", SUBSTRING_INDEX(CURRENT_USER(), '@', 1), "'%")
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
