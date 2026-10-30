import type { NormalizedRiskProfile } from '../../contracts/database-adapter.js';
import { QueryPlanAnalysisError } from '../../core/errors.js';

/**
 * Normalizes SQL Server `SHOWPLAN_XML` output into a `NormalizedRiskProfile`.
 */
export function normalizeSqlServerPlanXml(
  showplanXml: string,
  adapterId: string
): NormalizedRiskProfile {
  const xml = showplanXml.trim();
  if (!xml.includes('<ShowPlanXML') || !xml.includes('<RelOp')) {
    throw new QueryPlanAnalysisError(adapterId, 'Invalid or incomplete SHOWPLAN_XML payload.');
  }

  const relOpRegex = /<RelOp\b([^>]*)>/g;
  const matches = Array.from(xml.matchAll(relOpRegex));
  if (matches.length === 0) {
    throw new QueryPlanAnalysisError(adapterId, 'No RelOp elements found in SHOWPLAN_XML.');
  }

  const parseAttr = (attrs: string, name: string): string | undefined => {
    const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
    return m?.[1];
  };

  const rootAttrs = matches[0]![1] ?? '';
  const estimatedRows = Math.max(0, Number(parseAttr(rootAttrs, 'EstimateRows') ?? 0));
  const estimatedCost = Math.max(
    0,
    Number(parseAttr(rootAttrs, 'EstimatedTotalSubtreeCost') ?? 0)
  );

  let hasFullScan = false;
  let hasUnconditionalJoin = false;
  const operators: string[] = [];

  for (const match of matches) {
    const attrs = match[1] ?? '';
    const physicalOp = parseAttr(attrs, 'PhysicalOp') ?? 'Unknown';
    operators.push(physicalOp);

    if (physicalOp === 'Table Scan') {
      hasFullScan = true;
    } else if (physicalOp === 'Clustered Index Scan') {
      hasFullScan = true;
    }

    const noJoinPredicate = parseAttr(attrs, 'NoJoinPredicate');
    if (noJoinPredicate === '1' || noJoinPredicate?.toLowerCase() === 'true') {
      hasUnconditionalJoin = true;
    }
  }

  return {
    hasFullScan,
    hasUnconditionalJoin,
    estimatedRows: Number.isFinite(estimatedRows) ? estimatedRows : 0,
    estimatedCost: Number.isFinite(estimatedCost) ? estimatedCost : 0,
    scannedTables: Array.from(xml.matchAll(/<Object\b[^>]*\bTable="\[\?(\[\^\\\]"\]\*)\]\?"/gi)).map(m => m[1]?.replace(/\[|\]/g, '').split('.').pop()?.toLowerCase() ?? '').filter(Boolean),
    rawPlanSummary: operators.join(' -> ')
  };
}
