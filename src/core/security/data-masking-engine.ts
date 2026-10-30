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
  doesColumnMatchRule
} from './masking-rules.js';

/**
 * In-Memory Data Masking Engine (`FR-015` to `FR-020`, Principle IV).
 * Obscures sensitive PII and financial data in volatile memory before MCP serialization.
 * Raw sensitive values never leave the server process.
 */
export class DataMaskingEngine implements IDataMaskingEngine {
  private readonly defaultProfile: MaskingProfile;

  constructor(defaultProfile: MaskingProfile = DEFAULT_MASKING_PROFILE) {
    this.defaultProfile = defaultProfile;
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
      const matched = columnRules.find((r) => doesColumnMatchRule(col.name, r));
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

        // 1. Check column-level rule (including dynamic columns not listed in result.columns)
        let colRule = columnRuleMap.get(colName);
        if (!colRule) {
          colRule = columnRules.find((r) => doesColumnMatchRule(colName, r));
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

        // 2. Evaluate content-pattern rules over string values
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

    const durationMs = Math.max(0, performance.now() - startTime);
    return {
      columns: result.columns,
      rows: maskedRows,
      rowCount: maskedRows.length,
      maskedCellsCount,
      durationMs
    };
  }
}
