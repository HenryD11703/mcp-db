import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdversarialCorpusSchema,
  MANDATORY_ATTACK_VECTORS
} from '../../src/core/validation/corpus-schema.js';
import { HardenedAstValidator } from '../../src/core/validation/ast-validator.js';
import type { EngineDialect } from '../../src/contracts/database-adapter.js';

describe('Adversarial SQL Corpus CI Suite (10 Mandatory Attack Vectors)', () => {
  const corpusPath = resolve(process.cwd(), 'corpus/adversarial-attacks.json');
  const rawCorpus = JSON.parse(readFileSync(corpusPath, 'utf-8'));
  const corpus = AdversarialCorpusSchema.parse(rawCorpus);
  const validator = new HardenedAstValidator();

  it('validates corpus structure and ensures all 10 mandatory vectors have >= 3 test cases', () => {
    expect(corpus.minimumVectorsRequired).toBe(10);
    for (const vector of MANDATORY_ATTACK_VECTORS) {
      const count = corpus.cases.filter((c) => c.vector === vector).length;
      expect(count, `Vector ${vector} must have at least 3 test cases`).toBeGreaterThanOrEqual(3);
    }
  });

  for (const testCase of corpus.cases) {
    const targetDialects: ReadonlyArray<EngineDialect> =
      testCase.dialect === 'common' ? ['tsql', 'postgres'] : [testCase.dialect];

    for (const dialect of targetDialects) {
      it(`[${testCase.id}] (${testCase.vector} | ${dialect}) -> ${testCase.expectedOutcome}: ${testCase.description}`, () => {
        const result = validator.validateSelectOnly(testCase.sql, dialect);

        if (testCase.expectedOutcome === 'REJECT') {
          expect(
            result.allowed,
            `Expected attack ${testCase.id} to be REJECTED in dialect ${dialect}, but it was ALLOWED`
          ).toBe(false);
          expect(result.reasonCode).toBe(testCase.expectedReasonCode);
        } else {
          expect(
            result.allowed,
            `Expected control query ${testCase.id} to be ALLOWED in dialect ${dialect}, but it was REJECTED with ${result.reasonCode}: ${result.message}`
          ).toBe(true);
        }
      });
    }
  }
});
