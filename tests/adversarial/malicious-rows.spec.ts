import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { MaskedDataset } from '../../src/contracts/security.contract.js';
import { ZeroTrustSanitizer } from '../../src/core/security/zero-trust-sanitizer.js';

const AdversarialRowCorpusSchema = z.object({
  version: z.string(),
  description: z.string(),
  categories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string()
    })
  ),
  cases: z
    .array(
      z.object({
        id: z.string(),
        category: z.enum([
          'R01_PROMPT_INJECTION',
          'R02_DELIMITER_BREAK',
          'R03_CONTROL_CHARS',
          'R04_FORMAT_SPOOFING',
          'R05_SPECIAL_TOKENS'
        ]),
        description: z.string(),
        columnName: z.string(),
        maliciousCellContent: z.string(),
        expectedInOutput: z.string(),
        forbiddenInOutput: z.string()
      })
    )
    .min(15)
});

describe('Adversarial Malicious Database Rows Suite (Zero-Trust Verification)', () => {
  const corpusPath = resolve(process.cwd(), 'corpus/adversarial-rows.json');
  const rawJson = JSON.parse(readFileSync(corpusPath, 'utf-8')) as unknown;
  const corpus = AdversarialRowCorpusSchema.parse(rawJson);
  const sanitizer = new ZeroTrustSanitizer();

  it('validates corpus schema and covers all 5 mandatory row attack categories', () => {
    const categoriesPresent = new Set(corpus.cases.map((c) => c.category));
    expect(categoriesPresent.has('R01_PROMPT_INJECTION')).toBe(true);
    expect(categoriesPresent.has('R02_DELIMITER_BREAK')).toBe(true);
    expect(categoriesPresent.has('R03_CONTROL_CHARS')).toBe(true);
    expect(categoriesPresent.has('R04_FORMAT_SPOOFING')).toBe(true);
    expect(categoriesPresent.has('R05_SPECIAL_TOKENS')).toBe(true);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const testCase of corpus.cases) {
    it(`[${testCase.id}] (${testCase.category}) neutralizes: ${testCase.description}`, () => {
      const dataset: MaskedDataset = {
        columns: [{ name: testCase.columnName, dataType: 'text' }],
        rows: [{ [testCase.columnName]: testCase.maliciousCellContent }],
        rowCount: 1,
        maskedCellsCount: 0,
        durationMs: 1
      };

      const xmlOutput = sanitizer.encapsulateDataset(dataset, { format: 'semantic_xml' });
      expect(xmlOutput.formattedText).toContain(testCase.expectedInOutput);
      expect(xmlOutput.formattedText).not.toContain(testCase.forbiddenInOutput);

      const jsonOutput = sanitizer.encapsulateDataset(dataset, { format: 'strict_json' });
      expect(jsonOutput.formattedText).toContain(testCase.expectedInOutput);
      expect(jsonOutput.formattedText).not.toContain(testCase.forbiddenInOutput);
    });
  }
});
