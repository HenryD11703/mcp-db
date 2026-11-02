import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LexicalColumnAnalyzer } from '../../src/core/security/lexical-column-analyzer.js';

interface TestCase {
  column: string;
  label: 'sensible' | 'no_sensible';
  dataType: string;
  variant: string;
}

interface Corpus {
  cases: TestCase[];
}

describe('LexicalColumnAnalyzer against column-name-sensitivity-corpus.json', () => {
  const corpusPath = path.resolve(process.cwd(), 'corpus/column-name-sensitivity-corpus.json');
  const rawCorpus = fs.readFileSync(corpusPath, 'utf8');
  const corpus: Corpus = JSON.parse(rawCorpus);

  const analyzer = new LexicalColumnAnalyzer();

  it('detects 100% of sensible cases in corpus without missing any (0% false negatives)', () => {
    const sensibleCases = corpus.cases.filter((c) => c.label === 'sensible');
    const failures: Array<{ column: string; detectedType?: string; confidence: string }> = [];

    for (const tc of sensibleCases) {
      const result = analyzer.classifyColumn(tc.column);
      if (!result.isSensitive || result.confidence === 'none') {
        failures.push({
          column: tc.column,
          detectedType: result.dataType,
          confidence: result.confidence
        });
      }
    }

    if (failures.length > 0) {
      console.error('Sensible columns failed detection:', failures);
    }
    expect(failures).toHaveLength(0);
  });

  it('rejects 100% of no_sensible cases in corpus (0% false positives, unit, monitor, benito, etc.)', () => {
    const nonSensibleCases = corpus.cases.filter((c) => c.label === 'no_sensible');
    const falsePositives: Array<{ column: string; detectedType?: string; confidence: string }> = [];

    for (const tc of nonSensibleCases) {
      const result = analyzer.classifyColumn(tc.column);
      if (result.isSensitive || result.confidence !== 'none') {
        falsePositives.push({
          column: tc.column,
          detectedType: result.dataType,
          confidence: result.confidence
        });
      }
    }

    if (falsePositives.length > 0) {
      console.error('Non-sensible columns falsely flagged:', falsePositives);
    }
    expect(falsePositives).toHaveLength(0);
  });
});
