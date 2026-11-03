import pkg from 'node-sql-parser';
import type {
  EngineDialect,
  SqlParserCandidate,
  SqlValidationResult
} from '../../contracts/database-adapter.js';
import { scanSqlLexically } from './lexical-scanner.js';

const { Parser } = pkg;

const FORBIDDEN_AST_FUNCTIONS = new Set([
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_stat_file',
  'pg_ls_dir',
  'pg_ls_logdir',
  'pg_ls_waldir',
  'pg_ls_tmpdir',
  'lo_import',
  'lo_export',
  'set_config',
  'dblink',
  'dblink_exec',
  'xp_cmdshell',
  'sp_oacreate',
  'sp_configure',
  'load_file',
  'sys_eval',
  'sys_exec',
  'sleep',
  'benchmark',
  'get_lock',
  'load_extension',
  'randomblob',
  'zeroblob'
]);

function resolveParserDatabase(dialect: EngineDialect): string {
  switch (dialect) {
    case 'tsql':
      return 'TransactSQL';
    case 'postgres':
      return 'Postgresql';
    case 'mysql':
      return 'MySQL';
    case 'mariadb':
      return 'MariaDB';
    case 'sqlite':
      return 'Sqlite';
    default:
      return 'Postgresql';
  }
}

/**
 * Production SQL AST Validator combining the String-Aware Lexical Scanner
 * with `node-sql-parser` AST verification across T-SQL and PostgreSQL.
 */
export class HardenedAstValidator implements SqlParserCandidate {
  public readonly candidateName = 'HardenedAstValidator (Lexical + node-sql-parser AST)';
  private readonly parser = new Parser();

  public validateSelectOnly(sql: string, dialect: EngineDialect): SqlValidationResult {
    // Stage 1: Deterministic string-aware lexical & structural guard
    const lexicalResult = scanSqlLexically(sql, dialect);
    if (!lexicalResult.allowed) {
      return lexicalResult;
    }

    // Stage 2: Full AST parse and recursive node inspection
    const parserDatabase = resolveParserDatabase(dialect);
    let astResult: unknown;
    try {
      astResult = this.parser.astify(sql, { database: parserDatabase });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid SQL syntax';
      return {
        allowed: false,
        reasonCode: 'SYNTAX_ERROR',
        message: `AST parser rejected SQL syntax: ${msg}`
      };
    }

    const statements = Array.isArray(astResult) ? astResult : [astResult];
    if (statements.length === 0) {
      return {
        allowed: false,
        reasonCode: 'EMPTY_QUERY',
        message: 'AST produced no statements.'
      };
    }

    if (statements.length > 1) {
      return {
        allowed: false,
        reasonCode: 'V01_STACKED_QUERIES',
        message: 'Multiple SQL statements detected in AST.'
      };
    }

    const rootNode = statements[0] as Record<string, unknown> | null;
    if (!rootNode || typeof rootNode !== 'object') {
      return {
        allowed: false,
        reasonCode: 'SYNTAX_ERROR',
        message: 'Invalid root AST node.'
      };
    }

    const rootType = String(rootNode['type'] ?? '').toLowerCase();
    if (rootType !== 'select') {
      return {
        allowed: false,
        reasonCode: 'NON_SELECT_ROOT',
        message: `Root AST statement must be SELECT, found "${rootType}".`
      };
    }

    const astViolation = this.inspectAstNodeRecursively(rootNode);
    if (astViolation) {
      return astViolation;
    }

    return { allowed: true };
  }

  private inspectAstNodeRecursively(
    node: unknown,
    visited: Set<object> = new Set()
  ): SqlValidationResult | null {
    if (!node || typeof node !== 'object') {
      return null;
    }
    if (visited.has(node)) {
      return null;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        const res = this.inspectAstNodeRecursively(item, visited);
        if (res) return res;
      }
      return null;
    }

    const record = node as Record<string, unknown>;
    const nodeType = String(record['type'] ?? '').toLowerCase();

    // Check non-SELECT statement types inside CTEs or subtrees
    if (
      nodeType === 'insert' ||
      nodeType === 'update' ||
      nodeType === 'delete' ||
      nodeType === 'replace' ||
      nodeType === 'truncate' ||
      nodeType === 'drop' ||
      nodeType === 'alter' ||
      nodeType === 'create'
    ) {
      return {
        allowed: false,
        reasonCode: 'V04_MUTATING_CTE',
        message: `Mutating AST node "${nodeType}" is prohibited inside SELECT.`
      };
    }

    // Check SELECT INTO in AST
    const intoProp = record['into'] as Record<string, unknown> | undefined;
    if (intoProp && typeof intoProp === 'object' && intoProp['expr']) {
      return {
        allowed: false,
        reasonCode: 'V02_SELECT_INTO',
        message: 'SELECT INTO clause detected in AST.'
      };
    }

    // Check explicit locking in AST (for_update / lock_in_share_mode)
    if (record['for_update'] || record['lock_in_share_mode']) {
      return {
        allowed: false,
        reasonCode: 'V06_EXPLICIT_LOCKING',
        message: 'Explicit row locking clause detected in AST.'
      };
    }

    // Check function calls in AST
    if (nodeType === 'function') {
      const fnName = this.extractFunctionName(record).toLowerCase();
      if (fnName === 'pg_sleep') {
        return {
          allowed: false,
          reasonCode: 'V09_DELAY_DOS',
          message: 'Function pg_sleep is prohibited.'
        };
      }
      if (
        fnName === 'openquery' ||
        fnName === 'openrowset' ||
        fnName === 'opendatasource'
      ) {
        return {
          allowed: false,
          reasonCode: 'V07_REMOTE_LINKED_ACCESS',
          message: `Remote access function "${fnName}" is prohibited.`
        };
      }
      if (FORBIDDEN_AST_FUNCTIONS.has(fnName)) {
        return {
          allowed: false,
          reasonCode: 'V05_DANGEROUS_FUNCTIONS',
          message: `Dangerous function "${fnName}" is prohibited.`
        };
      }
    }

    // Check 4-part table references if exposed in AST from node
    if (typeof record['server'] === 'string' && record['server'].length > 0) {
      return {
        allowed: false,
        reasonCode: 'V07_REMOTE_LINKED_ACCESS',
        message: 'Four-part linked server object reference detected in AST.'
      };
    }

    for (const value of Object.values(record)) {
      const childResult = this.inspectAstNodeRecursively(value, visited);
      if (childResult) {
        return childResult;
      }
    }

    return null;
  }

  private extractFunctionName(fnNode: Record<string, unknown>): string {
    const rawName = fnNode['name'];
    if (typeof rawName === 'string') {
      return rawName;
    }
    if (rawName && typeof rawName === 'object') {
      const nameObj = rawName as Record<string, unknown>;
      if (Array.isArray(nameObj['name']) && nameObj['name'].length > 0) {
        const lastPart = nameObj['name'][nameObj['name'].length - 1] as Record<
          string,
          unknown
        >;
        if (lastPart && typeof lastPart['value'] === 'string') {
          return lastPart['value'];
        }
      }
    }
    return '';
  }
}
