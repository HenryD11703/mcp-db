import type {
  EngineDialect,
  SqlParserCandidate,
  SqlValidationResult
} from '../../contracts/database-adapter.js';
import type {
  ExtendedSqlValidationResult,
  ISqlSecurityGuard
} from '../../contracts/security.contract.js';
import { HardenedAstValidator } from '../validation/ast-validator.js';
import { scanSqlLexically } from '../validation/lexical-scanner.js';

const CALL_PROCEDURE_REGEX = /^\s*CALL\s+[a-zA-Z_][\w$#.]*/i;

/**
 * Production SQL Security Guard enforcing strict read-only SELECT execution (`FR-001` to `FR-009`).
 * Coordinates the 2-stage validation pipeline:
 * 1. String-aware lexical scanning (rejecting comments `--`/`/* *\/`, stacked queries `;`, `EXEC`, `CALL`, etc.)
 * 2. AST structural verification via `HardenedAstValidator` (enforcing single root `SELECT`, no `SELECT INTO`,
 *    no mutating CTEs, and no dangerous administrative functions).
 */
export class SqlSecurityGuard implements ISqlSecurityGuard, SqlParserCandidate {
  public readonly candidateName = 'SqlSecurityGuard (2-Stage Lexical + AST Guard)';
  private readonly astValidator: HardenedAstValidator;

  constructor(astValidator: HardenedAstValidator = new HardenedAstValidator()) {
    this.astValidator = astValidator;
  }

  public validateQuery(sql: string, dialect: EngineDialect): ExtendedSqlValidationResult {
    const lexical = scanSqlLexically(sql, dialect);
    if (!lexical.allowed) {
      return {
        allowed: false,
        reasonCode: lexical.reasonCode,
        message: lexical.message,
        detectedInStage: 'lexical'
      };
    }

    if (lexical.neutralizedSql && CALL_PROCEDURE_REGEX.test(lexical.neutralizedSql)) {
      return {
        allowed: false,
        reasonCode: 'V08_PROCEDURE_CALL',
        message: 'Stored procedure calls (CALL) are strictly prohibited.',
        detectedInStage: 'lexical'
      };
    }

    const astResult = this.astValidator.validateSelectOnly(sql, dialect);
    if (!astResult.allowed) {
      return {
        allowed: false,
        reasonCode: astResult.reasonCode,
        message: astResult.message,
        detectedInStage: 'ast'
      };
    }

    return { allowed: true };
  }

  public validateSelectOnly(sql: string, dialect: EngineDialect): SqlValidationResult {
    const res = this.validateQuery(sql, dialect);
    if (res.allowed) {
      return { allowed: true };
    }
    const mappedCode =
      res.reasonCode === 'V08_PROCEDURE_CALL'
        ? 'V08_TSQL_IMPLICIT_EXEC'
        : res.reasonCode === 'V05_FORBIDDEN_FUNCTION'
          ? 'V05_DANGEROUS_FUNCTIONS'
          : (res.reasonCode ?? 'NON_SELECT_ROOT');
    return {
      allowed: false,
      reasonCode: mappedCode as SqlValidationResult['reasonCode'],
      message: res.message
    };
  }
}
