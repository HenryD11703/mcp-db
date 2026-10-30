import type { ISqlSanitizerForAudit } from '../../contracts/audit.contract.js';

export class SqlSanitizerForAudit implements ISqlSanitizerForAudit {
  private readonly maxSqlLength: number;

  constructor(maxSqlLength: number = 16 * 1024) {
    this.maxSqlLength = maxSqlLength;
  }

  /**
   * Sanitizes all string and numeric literals in the SQL statement.
   * Strings ('...') -> '[REDACTED_LITERAL]'
   * Numbers in predicates (= 123, > 50.5) -> [REDACTED_NUM]
   * Parameter values are never embedded.
   * Truncates at maxSqlLength (16 KB) with [TRUNCATED] suffix.
   */
  public sanitizeSqlForAudit(rawSql: string): string {
    if (!rawSql || typeof rawSql !== 'string') {
      return '';
    }

    let isTruncated = false;
    let sql = rawSql.trim();

    // 1. Truncate if exceeds maximum length limit
    if (sql.length > this.maxSqlLength) {
      sql = sql.slice(0, this.maxSqlLength);
      isTruncated = true;
    }

    // 2. Redact single-quoted and double-quoted string literals: 'text' or "text"
    // Handle escaped quotes '' inside string literals
    sql = sql.replace(/'(?:''|[^'])*'/g, "'[REDACTED_LITERAL]'");

    // 3. Redact numeric literals following comparison operators or keywords
    // e.g. = 123, > 45.67, <= 999, IN (1, 2, 3), VALUES (1, 2)
    sql = sql.replace(
      /(=|!=|<>|<=|>=|<|>|\bIN\s*\(|\bVALUES\s*\(|,|\bBETWEEN\s+)\s*(-?\d+(?:\.\d+)?)/gi,
      (_match, prefix, _num) => `${prefix.trimEnd()}${prefix.endsWith('(') ? '' : ' '}[REDACTED_NUM]`
    );

    // Also handle trailing numbers in lists: e.g. , 123 -> , [REDACTED_NUM]
    sql = sql.replace(/,\s*(-?\d+(?:\.\d+)?)/g, ', [REDACTED_NUM]');

    // 4. Redact numbers after AND in BETWEEN clauses: BETWEEN [REDACTED_NUM] AND 500
    sql = sql.replace(
      /(\bBETWEEN\s+\[REDACTED_NUM\]\s+AND\s+)(-?\d+(?:\.\d+)?)/gi,
      '$1[REDACTED_NUM]'
    );

    if (isTruncated || sql.length > this.maxSqlLength) {
      sql = sql.slice(0, this.maxSqlLength) + ' [TRUNCATED]';
    }

    return sql;
  }
}
