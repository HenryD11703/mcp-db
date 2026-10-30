import type { NormalizedRiskProfile } from '../../contracts/database-adapter.js';
import { QueryPlanAnalysisError } from '../../core/errors.js';

export interface PostgresPlanNode {
  readonly 'Node Type'?: string;
  readonly 'Plan Rows'?: number;
  readonly 'Total Cost'?: number;
  readonly 'Hash Cond'?: string;
  readonly 'Merge Cond'?: string;
  readonly 'Join Filter'?: string;
  readonly 'Index Cond'?: string;
  readonly Plans?: ReadonlyArray<PostgresPlanNode>;
}

/**
 * Normalizes PostgreSQL `EXPLAIN (FORMAT JSON)` output into a `NormalizedRiskProfile`.
 */
export function normalizePostgresPlan(
  explainOutput: unknown,
  adapterId: string
): NormalizedRiskProfile {
  const rootWrapper = Array.isArray(explainOutput) ? explainOutput[0] : explainOutput;
  if (!rootWrapper || typeof rootWrapper !== 'object') {
    throw new QueryPlanAnalysisError(adapterId, 'Invalid EXPLAIN JSON payload.');
  }

  const rootPlan = (rootWrapper as { Plan?: PostgresPlanNode }).Plan;
  if (!rootPlan || typeof rootPlan !== 'object') {
    throw new QueryPlanAnalysisError(adapterId, 'Missing root Plan node in EXPLAIN JSON.');
  }

  let hasFullScan = false;
  let hasUnconditionalJoin = false;
  const operators: string[] = [];

  const visit = (node: PostgresPlanNode): void => {
    const nodeType = node['Node Type'] ?? 'Unknown';
    operators.push(nodeType);

    if (nodeType === 'Seq Scan') {
      hasFullScan = true;
    }

    if (
      nodeType === 'Nested Loop' ||
      nodeType === 'Hash Join' ||
      nodeType === 'Merge Join'
    ) {
      const hasExplicitCond = Boolean(
        node['Hash Cond'] || node['Merge Cond'] || node['Join Filter']
      );
      const children = node.Plans ?? [];
      const hasCorrelatedIndexSeek = children.some(
        (child) => Boolean(child['Index Cond']) && child['Node Type'] !== 'Seq Scan'
      );

      // For Nested Loop without Join Filter, check if inner child is a parameterized/indexed lookup;
      // if neither explicit join condition nor parameterized inner index condition exists, flag unconditional join.
      if (!hasExplicitCond && !hasCorrelatedIndexSeek) {
        hasUnconditionalJoin = true;
      } else if (
        nodeType === 'Nested Loop' &&
        !hasExplicitCond &&
        children.length >= 2 &&
        !children[1]?.['Index Cond']
      ) {
        hasUnconditionalJoin = true;
      }
    }

    for (const child of node.Plans ?? []) {
      visit(child);
    }
  };

  visit(rootPlan);

  const estimatedRows = Math.max(0, Number(rootPlan['Plan Rows'] ?? 0));
  const estimatedCost = Math.max(0, Number(rootPlan['Total Cost'] ?? 0));

  return {
    hasFullScan,
    hasUnconditionalJoin,
    estimatedRows: Number.isFinite(estimatedRows) ? estimatedRows : 0,
    estimatedCost: Number.isFinite(estimatedCost) ? estimatedCost : 0,
    rawPlanSummary: operators.join(' -> ')
  };
}
