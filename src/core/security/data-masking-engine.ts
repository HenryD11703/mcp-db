import type { QueryExecutionResult } from '../../contracts/database-adapter.js';
import type {
  IDataMaskingEngine,
  MaskedDataset,
  MaskingProfile,
  MaskingRule
} from '../../contracts/security.contract.js';
import { DEFAULT_MASKING_PROFILE } from './default-masking-profile.js';
import {
  applyMaskingStrategy,
  compileRuleMatcher,
  doesColumnMatchRule,
  isValidNitContent
} from './masking-rules.js';
import { LexicalColumnAnalyzer } from './lexical-column-analyzer.js';

/**
 * In-Memory Data Masking Engine (`FR-015` to `FR-020`, Principle IV).
 * Obscures sensitive PII and financial data in volatile memory before MCP serialization.
 * Raw sensitive values never leave the server process.
 */
export class DataMaskingEngine implements IDataMaskingEngine {
  private readonly defaultProfile: MaskingProfile;
  private readonly lexicalAnalyzer = new LexicalColumnAnalyzer();

  constructor(defaultProfile: MaskingProfile = DEFAULT_MASKING_PROFILE) {
    this.defaultProfile = defaultProfile;
  }

  private resolveColumnRule(
    colName: string,
    columnRules: ReadonlyArray<MaskingRule>
  ): MaskingRule | undefined {
    // 1. Detección léxica robusta (Capa 0 a 4)
    const lexical = this.lexicalAnalyzer.classifyColumn(colName);
    if (lexical.isSensitive && lexical.confidence !== 'none') {
      const configured = columnRules.find((r) => r.dataType === lexical.dataType);
      return {
        id: `lex-${lexical.dataType}-${colName}`,
        targetType: 'column_name',
        matcher: colName,
        dataType: lexical.dataType,
        strategy:
          configured?.strategy ??
          (lexical.dataType === 'amount' ? 'mask_amount' : 'partial'),
        enabled: true
      };
    }

    // 2. Reglas estándar de perfil
    return columnRules.find((r) => doesColumnMatchRule(colName, r));
  }

  public maskDataset(
    result: QueryExecutionResult,
    profile: MaskingProfile = this.defaultProfile
  ): MaskedDataset {
    const startTime = performance.now();
    const enabledRules = profile.rules.filter((r) => r.enabled);
    const columnRules = enabledRules.filter((r) => r.targetType === 'column_name');
    const patternRules = enabledRules.filter((r) => r.targetType === 'content_pattern');

    // Pre-resolve column-level rules by column name
    const columnRuleMap = new Map<string, MaskingRule>();
    for (const col of result.columns) {
      const matched = this.resolveColumnRule(col.name, columnRules);
      if (matched) {
        columnRuleMap.set(col.name, matched);
      }
    }

    let maskedCellsCount = 0;
    const maskedRows: Record<string, unknown>[] = [];

    for (const rawRow of result.rows) {
      const newRow: Record<string, unknown> = {};

      for (const [colName, rawVal] of Object.entries(rawRow)) {
        if (rawVal === null || rawVal === undefined || typeof rawVal === 'boolean') {
          newRow[colName] = rawVal;
          continue;
        }

        // 1. Check column-level rule
        let colRule = columnRuleMap.get(colName);
        if (!colRule) {
          colRule = this.resolveColumnRule(colName, columnRules);
          if (colRule) {
            columnRuleMap.set(colName, colRule);
          }
        }

        if (colRule && (typeof rawVal === 'string' || typeof rawVal === 'number')) {
          newRow[colName] = applyMaskingStrategy(
            String(rawVal),
            colRule.dataType,
            colRule.strategy,
            colRule.customMask,
            colRule.customTransformer
          );
          maskedCellsCount++;
          continue;
        }

        // 2. Evaluate content-pattern rules over string values (cell fallback)
        if (typeof rawVal === 'string') {
          let currentStr = rawVal;
          let cellWasMasked = false;

          for (const patRule of patternRules) {
            const regex = compileRuleMatcher(patRule.matcher, false);
            const globalRegex = new RegExp(
              regex.source,
              regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
            );

            const replaced = currentStr.replace(globalRegex, (match) => {
              if (patRule.dataType === 'nit' && !isValidNitContent(match)) {
                return match;
              }

              cellWasMasked = true;
              return applyMaskingStrategy(
                match,
                patRule.dataType,
                patRule.strategy,
                patRule.customMask,
                patRule.customTransformer
              );
            });
            currentStr = replaced;
          }

          if (cellWasMasked) {
            maskedCellsCount++;
          }
          newRow[colName] = currentStr;
          continue;
        }

        newRow[colName] = rawVal;
      }

      maskedRows.push(newRow);
    }

    const durationMs = performance.now() - startTime;

    return {
      columns: result.columns,
      rows: maskedRows,
      rowCount: result.rowCount,
      maskedCellsCount,
      durationMs
    };
  }
}
