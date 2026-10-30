import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdversarialCorpusSchema } from '../../src/core/validation/corpus-schema.js';
import {
  BaselineNodeSqlParserCandidate,
  evaluateParserCandidates,
  formatBenchmarkMarkdown
} from '../../src/core/validation/parser-benchmark.js';
import { HardenedAstValidator } from '../../src/core/validation/ast-validator.js';

describe('SQL Parser Candidate Evaluation against Adversarial Corpus (FR-013)', () => {
  const corpusPath = resolve(process.cwd(), 'corpus/adversarial-attacks.json');
  const corpus = AdversarialCorpusSchema.parse(JSON.parse(readFileSync(corpusPath, 'utf-8')));

  it('compares raw node-sql-parser against HardenedAstValidator and proves 100% block rate on chosen validator', () => {
    const baseline = new BaselineNodeSqlParserCandidate();
    const hardened = new HardenedAstValidator();

    const report = evaluateParserCandidates(corpus, [baseline, hardened]);
    const markdown = formatBenchmarkMarkdown(report);

    expect(markdown).toContain('HardenedAstValidator');
    expect(markdown).toContain('BaselineNodeSqlParser');

    const hardenedSummary = report.candidates.find(
      (c) => c.candidateName === hardened.candidateName
    );
    const baselineSummary = report.candidates.find(
      (c) => c.candidateName === baseline.candidateName
    );

    expect(hardenedSummary).toBeDefined();
    expect(hardenedSummary?.attacksBlocked).toBe(hardenedSummary?.totalAttackEvaluations);
    expect(hardenedSummary?.falseNegatives).toBe(0);
    expect(hardenedSummary?.falsePositives).toBe(0);

    // Raw node-sql-parser without lexical/AST hardening lets several vectors pass (e.g. comments, FOR UPDATE, dangerous functions)
    expect(baselineSummary).toBeDefined();
    expect(baselineSummary!.falseNegatives).toBeGreaterThan(0);
  });
});
