import pkg from 'node-sql-parser';
import type {
  AttackVectorId,
  EngineDialect,
  SqlParserCandidate,
  SqlValidationResult
} from '../../contracts/database-adapter.js';
import {
  MANDATORY_ATTACK_VECTORS,
  type AdversarialCorpus
} from './corpus-schema.js';

const { Parser } = pkg;

/**
 * Unhardened baseline parser candidate using raw `node-sql-parser`
 * (checks only `ast.type === 'select'` without lexical comment rejection or deep AST vector guards).
 * Used to demonstrate why the 10-vector adversarial corpus is essential for selecting/hardening the parser.
 */
export class BaselineNodeSqlParserCandidate implements SqlParserCandidate {
  public readonly candidateName = 'BaselineNodeSqlParser (Raw AST type === select only)';
  private readonly parser = new Parser();

  public validateSelectOnly(sql: string, dialect: EngineDialect): SqlValidationResult {
    try {
      const database = dialect === 'tsql' ? 'TransactSQL' : 'Postgresql';
      const ast = this.parser.astify(sql, { database });
      const statements = Array.isArray(ast) ? ast : [ast];
      if (statements.length !== 1) {
        return { allowed: false, reasonCode: 'V01_STACKED_QUERIES' };
      }
      const root = statements[0] as Record<string, unknown> | undefined;
      if (!root || String(root['type'] ?? '').toLowerCase() !== 'select') {
        return { allowed: false, reasonCode: 'NON_SELECT_ROOT' };
      }
      return { allowed: true };
    } catch {
      return { allowed: false, reasonCode: 'SYNTAX_ERROR' };
    }
  }
}

export interface VectorScore {
  readonly vector: AttackVectorId;
  readonly total: number;
  readonly blocked: number;
  readonly bypassedIds: ReadonlyArray<string>;
}

export interface CandidateBenchmarkSummary {
  readonly candidateName: string;
  readonly totalAttackEvaluations: number;
  readonly attacksBlocked: number;
  readonly falseNegatives: number;
  readonly totalControlEvaluations: number;
  readonly controlsAllowed: number;
  readonly falsePositives: number;
  readonly vectorBreakdown: ReadonlyArray<VectorScore>;
}

export interface BenchmarkReport {
  readonly corpusVersion: string;
  readonly evaluatedAt: string;
  readonly candidates: ReadonlyArray<CandidateBenchmarkSummary>;
}

export function evaluateParserCandidates(
  corpus: AdversarialCorpus,
  candidates: ReadonlyArray<SqlParserCandidate>
): BenchmarkReport {
  const summaries: CandidateBenchmarkSummary[] = candidates.map((candidate) => {
    let totalAttackEvaluations = 0;
    let attacksBlocked = 0;
    let totalControlEvaluations = 0;
    let controlsAllowed = 0;

    const vectorMap = new Map<
      AttackVectorId,
      { total: number; blocked: number; bypassedIds: string[] }
    >();
    for (const v of MANDATORY_ATTACK_VECTORS) {
      vectorMap.set(v, { total: 0, blocked: 0, bypassedIds: [] });
    }

    for (const testCase of corpus.cases) {
      const dialects: ReadonlyArray<EngineDialect> =
        testCase.dialect === 'common' ? ['tsql', 'postgres'] : [testCase.dialect];

      for (const dialect of dialects) {
        const result = candidate.validateSelectOnly(testCase.sql, dialect);
        if (testCase.vector === 'CONTROL_VALID_SELECT') {
          totalControlEvaluations++;
          if (result.allowed) {
            controlsAllowed++;
          }
        } else {
          totalAttackEvaluations++;
          const entry = vectorMap.get(testCase.vector)!;
          entry.total++;
          if (!result.allowed) {
            attacksBlocked++;
            entry.blocked++;
          } else {
            entry.bypassedIds.push(`${testCase.id} (${dialect})`);
          }
        }
      }
    }

    const vectorBreakdown: VectorScore[] = MANDATORY_ATTACK_VECTORS.map((vector) => {
      const stats = vectorMap.get(vector)!;
      return {
        vector,
        total: stats.total,
        blocked: stats.blocked,
        bypassedIds: stats.bypassedIds
      };
    });

    return {
      candidateName: candidate.candidateName,
      totalAttackEvaluations,
      attacksBlocked,
      falseNegatives: totalAttackEvaluations - attacksBlocked,
      totalControlEvaluations,
      controlsAllowed,
      falsePositives: totalControlEvaluations - controlsAllowed,
      vectorBreakdown
    };
  });

  return {
    corpusVersion: corpus.version,
    evaluatedAt: new Date().toISOString(),
    candidates: summaries
  };
}

export function formatBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [
    '# Reporte de Evaluación de Parsers SQL contra Corpus Adversario',
    '',
    `- **Versión del Corpus**: \`${report.corpusVersion}\``,
    `- **Fecha de Evaluación**: \`${report.evaluatedAt}\``,
    '',
    '## Resumen Global por Candidato',
    '',
    '| Candidato | Ataques Bloqueados | Falsos Negativos (Ataques que pasaron) | Controles Permitidos | Falsos Positivos | Veredicto |',
    '| --- | --- | --- | --- | --- | --- |'
  ];

  for (const c of report.candidates) {
    const verdict =
      c.falseNegatives === 0 && c.falsePositives === 0 ? 'APROBADO (100%)' : 'RECHAZADO';
    lines.push(
      `| ${c.candidateName} | ${c.attacksBlocked}/${c.totalAttackEvaluations} | ${c.falseNegatives} | ${c.controlsAllowed}/${c.totalControlEvaluations} | ${c.falsePositives} | **${verdict}** |`
    );
  }

  lines.push('', '## Desglose por los 10 Vectores Obligatorios', '');
  for (const c of report.candidates) {
    lines.push(`### ${c.candidateName}`, '');
    lines.push('| Vector | Bloqueados / Total | Casos que evadieron el parser |');
    lines.push('| --- | --- | --- |');
    for (const v of c.vectorBreakdown) {
      const bypassed = v.bypassedIds.length === 0 ? 'Ninguno (0)' : v.bypassedIds.join(', ');
      lines.push(`| \`${v.vector}\` | ${v.blocked}/${v.total} | ${bypassed} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
