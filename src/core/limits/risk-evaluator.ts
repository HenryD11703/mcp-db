import type {
  DatabaseAdapter,
  EngineDialect,
  NormalizedRiskProfile,
  ParameterizedQuery
} from '../../contracts/database-adapter.js';
import type {
  EngineRiskThresholds,
  IQueryPlanRiskEvaluator,
  QueryPlanRiskProfile,
  RiskSeverity
} from '../../contracts/cost-limits.contract.js';

export class QueryPlanRiskEvaluator implements IQueryPlanRiskEvaluator {
  private readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter) {
    this.adapter = adapter;
  }

  public async evaluateRisk(
    query: ParameterizedQuery,
    _dialect: EngineDialect,
    thresholds: EngineRiskThresholds
  ): Promise<QueryPlanRiskProfile> {
    let normalizedPlan: NormalizedRiskProfile;
    let isVerifiable = true;
    const warnings: string[] = [];

    try {
      normalizedPlan = await this.fetchPlanWithTimeout(query, thresholds.planTimeoutMs);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      isVerifiable = false;
      warnings.push(`Plan no verificable: ${errorMessage}`);

      return {
        severity: 'MEDIUM_CAUTION',
        estimatedCost: 0,
        estimatedRows: 0,
        hasFullScan: false,
        scannedTables: [],
        hasCartesianJoin: false,
        isVerifiable: false,
        warnings,
        rawPlanSummary: 'Plan evaluation failed or timed out (fail-safe policy applied).'
      };
    }

    const scannedTables = (normalizedPlan.scannedTables ?? []).map((t) => t.toLowerCase());
    const largeTablesBlocklist = thresholds.largeTablesBlocklist.map((t) => t.toLowerCase());
    const touchedLargeTables = scannedTables.filter((t) => largeTablesBlocklist.includes(t));

    let severity: RiskSeverity = 'LOW';

    // 1. Critical block checks
    if (normalizedPlan.hasFullScan && touchedLargeTables.length > 0) {
      severity = 'CRITICAL_BLOCK';
      warnings.push(
        `Se detectó escaneo completo (Seq Scan / Table Scan) en tabla(s) protegida(s): ${touchedLargeTables.join(', ')}.`
      );
    }

    if (normalizedPlan.hasUnconditionalJoin && thresholds.prohibitCartesianJoins) {
      severity = 'CRITICAL_BLOCK';
      warnings.push(
        'Se detectó producto cartesiano o unión sin condición de enlace (Cross Join / Unconditional Nested Loop).'
      );
    }

    if (normalizedPlan.estimatedRows >= thresholds.maxEstimatedRowsBlock) {
      severity = 'CRITICAL_BLOCK';
      warnings.push(
        `Las filas estimadas (${normalizedPlan.estimatedRows}) superan el umbral de bloqueo crítico (${thresholds.maxEstimatedRowsBlock}).`
      );
    }

    if (normalizedPlan.estimatedCost >= thresholds.maxEstimatedCostBlock) {
      severity = 'CRITICAL_BLOCK';
      warnings.push(
        `El costo computacional estimado (${normalizedPlan.estimatedCost}) supera el umbral de bloqueo crítico (${thresholds.maxEstimatedCostBlock}).`
      );
    }

    // 2. Caution checks (if not already critical block)
    if (severity !== 'CRITICAL_BLOCK') {
      if (normalizedPlan.estimatedRows >= thresholds.maxEstimatedRowsCaution) {
        severity = 'MEDIUM_CAUTION';
        warnings.push(
          `Las filas estimadas (${normalizedPlan.estimatedRows}) superan el umbral de precaución (${thresholds.maxEstimatedRowsCaution}).`
        );
      }

      if (normalizedPlan.estimatedCost >= thresholds.maxEstimatedCostCaution) {
        severity = 'MEDIUM_CAUTION';
        warnings.push(
          `El costo computacional estimado (${normalizedPlan.estimatedCost}) supera el umbral de precaución (${thresholds.maxEstimatedCostCaution}).`
        );
      }
    }

    return {
      severity,
      estimatedCost: normalizedPlan.estimatedCost,
      estimatedRows: normalizedPlan.estimatedRows,
      hasFullScan: normalizedPlan.hasFullScan,
      scannedTables,
      hasCartesianJoin: normalizedPlan.hasUnconditionalJoin,
      isVerifiable,
      warnings,
      rawPlanSummary: normalizedPlan.rawPlanSummary
    };
  }

  private async fetchPlanWithTimeout(
    query: ParameterizedQuery,
    timeoutMs: number
  ): Promise<NormalizedRiskProfile> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`La estimación del plan de ejecución superó el tiempo de espera de ${timeoutMs}ms.`));
      }, timeoutMs);
      // Unref timer so it doesn't prevent Node process exit
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });

    return Promise.race([this.adapter.analyzeQueryPlan(query), timeoutPromise]);
  }
}
