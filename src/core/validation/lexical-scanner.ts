import type { EngineDialect, SqlValidationResult } from '../../contracts/database-adapter.js';

export interface LexicalScanOutput extends SqlValidationResult {
  /**
   * SQL text where string literals are replaced with neutral placeholders ('__STR__')
   * so downstream structural checks never match inside string literals.
   */
  readonly neutralizedSql?: string;
}

const DANGEROUS_FUNCTIONS_REGEX =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_read_file|pg_read_binary_file|pg_stat_file|pg_ls_dir|pg_ls_logdir|pg_ls_waldir|pg_ls_tmpdir|lo_import|lo_export|set_config|dblink|dblink_exec|xp_cmdshell|sp_oacreate|sp_configure|load_file|sys_eval|sys_exec|get_lock|load_extension|randomblob|zeroblob)\s*\(/i;

const DELAY_DOS_REGEX = /\b(WAITFOR\s+(DELAY|TIME)|pg_sleep\s*\(|sleep\s*\(|benchmark\s*\()/i;

const REMOTE_LINKED_FUNC_REGEX = /\b(OPENQUERY|OPENROWSET|OPENDATASOURCE)\s*\(/i;

const FOUR_PART_NAME_REGEX =
  /\b(FROM|JOIN)\s+([a-zA-Z_][\w$#]*|\[[^\]]+\]|"[^"]+")\s*\.\s*([a-zA-Z_][\w$#]*|\[[^\]]+\]|"[^"]+")\s*\.\s*([a-zA-Z_][\w$#]*|\[[^\]]+\]|"[^"]+")\s*\.\s*([a-zA-Z_][\w$#]*|\[[^\]]+\]|"[^"]+")/i;

const EXPLICIT_LOCKING_REGEX =
  /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b|\bWITH\s*\(\s*[^)]*\b(UPDLOCK|HOLDLOCK|TABLOCKX|XLOCK|PAGLOCK|TABLOCK)\b/i;

const MUTATING_CTE_REGEX =
  /\bWITH\b[\s\S]*?\bAS\s*\(\s*(DELETE|UPDATE|INSERT|MERGE|DROP|ALTER|CREATE|TRUNCATE)\b/i;

const SELECT_INTO_REGEX =
  /\bSELECT\b[\s\S]+?\bINTO\s+(TEMP\s+TABLE\s+|TEMPORARY\s+TABLE\s+|UNLOGGED\s+TABLE\s+)?(#?[a-zA-Z_][\w$#.]*|\[[^\]]+\]|"[^"]+")[\s\S]*?\bFROM\b/i;

const TSQL_IMPLICIT_EXEC_REGEX = /(^\s*|\s+)(EXEC|EXECUTE)\s+(@|[a-zA-Z_][\w$#.]*|\[[^\]]+\])/i;

const SESSION_OR_INTERNAL_CMD_REGEX =
  /(^\s*|\s+)(DBCC\s+[a-zA-Z_]+|SET\s+(TRANSACTION|ROWCOUNT|ANSI_NULLS|QUOTED_IDENTIFIER|NOCOUNT|DEADLOCK_PRIORITY|LOCK_TIMEOUT|IDENTITY_INSERT|STATISTICS|SHOWPLAN_XML|SHOWPLAN_ALL|SHOWPLAN_TEXT|FORCEPLAN|IMPLICIT_TRANSACTIONS|XACT_ABORT| default_transaction_read_only|session_replication_role|search_path|role|statement_timeout|work_mem|[a-zA-Z_][\w.]*\s*(=|TO\b|ON\b|OFF\b)))/i;

/**
 * Character-by-character string-aware lexical scanner.
 * Strictly rejects inline (--) and block (/* *\/) comments outside string literals (Vector 3)
 * and detects structural evasion patterns across T-SQL and PostgreSQL.
 */
export function scanSqlLexically(sql: string, dialect: EngineDialect): LexicalScanOutput {
  const trimmed = sql.trim();
  if (trimmed.length === 0) {
    return {
      allowed: false,
      reasonCode: 'EMPTY_QUERY',
      message: 'Query string cannot be empty.'
    };
  }

  let neutralized = '';
  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    const ch = trimmed[i]!;
    const next = i + 1 < len ? trimmed[i + 1]! : '';

    // 1. Single-quoted string literal: '...' (handles '' and Postgres E'...')
    if (ch === "'") {
      const isPostgresEscaped =
        dialect === 'postgres' && i > 0 && (trimmed[i - 1] === 'e' || trimmed[i - 1] === 'E');
      i++;
      while (i < len) {
        if (isPostgresEscaped && trimmed[i] === '\\') {
          i += 2;
          continue;
        }
        if (trimmed[i] === "'") {
          if (i + 1 < len && trimmed[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      neutralized += "'__STR__'";
      continue;
    }

    // 2. Double-quoted identifier: "..."
    if (ch === '"') {
      let ident = '"';
      i++;
      while (i < len) {
        if (trimmed[i] === '"') {
          if (i + 1 < len && trimmed[i + 1] === '"') {
            ident += '""';
            i += 2;
            continue;
          }
          ident += '"';
          i++;
          break;
        }
        ident += trimmed[i];
        i++;
      }
      neutralized += ident;
      continue;
    }

    // 3b. Backtick identifier: `...` (MySQL, MariaDB, SQLite)
    if (ch === "`") {
      let ident = "`";
      i++;
      while (i < len) {
        if (trimmed[i] === "`") {
          if (i + 1 < len && trimmed[i + 1] === "`") {
            ident += "``";
            i += 2;
            continue;
          }
          ident += "`";
          i++;
          break;
        }
        ident += trimmed[i];
        i++;
      }
      neutralized += ident;
      continue;
    }

    // 3. T-SQL bracketed identifier: [...]
    if (ch === '[') {
      let ident = '[';
      i++;
      while (i < len) {
        if (trimmed[i] === ']') {
          if (i + 1 < len && trimmed[i + 1] === ']') {
            ident += ']]';
            i += 2;
            continue;
          }
          ident += ']';
          i++;
          break;
        }
        ident += trimmed[i];
        i++;
      }
      neutralized += ident;
      continue;
    }

    // 4. PostgreSQL dollar-quoted string literal: $$...$$ or $tag$...$tag$
    if (ch === '$' && dialect === 'postgres') {
      const rest = trimmed.slice(i);
      const tagMatch = rest.match(/^\$([a-zA-Z_][\w]*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const endIdx = trimmed.indexOf(tag, i + tag.length);
        if (endIdx !== -1) {
          i = endIdx + tag.length;
          neutralized += "'__STR__'";
          continue;
        }
      }
    }

    // 5b. Hash comment outside literals: # (MySQL, MariaDB)
    if (ch === "#" && (dialect === "mysql" || dialect === "mariadb")) {
      return {
        allowed: false,
        reasonCode: "V03_COMMENT_OBFUSCATION",
        message: "Inline SQL comments (#) are strictly prohibited outside string literals."
      };
    }

    // 5. Inline comment outside literals: --
    if (ch === '-' && next === '-') {
      return {
        allowed: false,
        reasonCode: 'V03_COMMENT_OBFUSCATION',
        message: 'Inline SQL comments (--) are strictly prohibited outside string literals.'
      };
    }

    // 6. Block comment outside literals: /* ... */
    if (ch === '/' && next === '*') {
      return {
        allowed: false,
        reasonCode: 'V03_COMMENT_OBFUSCATION',
        message: 'Block SQL comments (/* */) are strictly prohibited outside string literals.'
      };
    }

    // 7. Semicolon outside literals (Vector 1: Stacked Queries)
    if (ch === ';') {
      return {
        allowed: false,
        reasonCode: 'V01_STACKED_QUERIES',
        message: 'Semicolons and stacked queries are strictly prohibited.'
      };
    }

    neutralized += ch;
    i++;
  }

  // Evaluate structural attack vectors on neutralized SQL (string contents already replaced)
  if (MUTATING_CTE_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V04_MUTATING_CTE',
      message: 'Writable CTEs (WITH ... DELETE/UPDATE/INSERT) are prohibited.'
    };
  }

  if (DELAY_DOS_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V09_DELAY_DOS',
      message: 'Delay/sleep functions and WAITFOR statements are prohibited.'
    };
  }

  if (SESSION_OR_INTERNAL_CMD_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V10_SESSION_OR_INTERNAL_CMD',
      message: 'Session modification (SET) and internal engine commands (DBCC) are prohibited.'
    };
  }

  if (TSQL_IMPLICIT_EXEC_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V08_TSQL_IMPLICIT_EXEC',
      message: 'Stored procedure execution (EXEC / EXECUTE) is prohibited.'
    };
  }

  if (REMOTE_LINKED_FUNC_REGEX.test(neutralized) || FOUR_PART_NAME_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V07_REMOTE_LINKED_ACCESS',
      message: 'Remote linked server access (OPENQUERY, OPENROWSET, OPENDATASOURCE, or 4-part names) is prohibited.'
    };
  }

  if (SELECT_INTO_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V02_SELECT_INTO',
      message: 'Table creation via SELECT INTO is prohibited.'
    };
  }

  if (EXPLICIT_LOCKING_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V06_EXPLICIT_LOCKING',
      message: 'Explicit row or table locking clauses (FOR UPDATE, FOR SHARE, lock hints) are prohibited.'
    };
  }

  if (DANGEROUS_FUNCTIONS_REGEX.test(neutralized)) {
    return {
      allowed: false,
      reasonCode: 'V05_DANGEROUS_FUNCTIONS',
      message: 'Administrative or filesystem database functions are prohibited.'
    };
  }

  return {
    allowed: true,
    neutralizedSql: neutralized
  };
}
