import { z } from 'zod';
import type { AttackVectorId, CorpusDialect, RejectionReasonCode } from '../../contracts/database-adapter.js';

export const MANDATORY_ATTACK_VECTORS: ReadonlyArray<AttackVectorId> = [
  'V01_STACKED_QUERIES',
  'V02_SELECT_INTO',
  'V03_COMMENT_OBFUSCATION',
  'V04_MUTATING_CTE',
  'V05_DANGEROUS_FUNCTIONS',
  'V06_EXPLICIT_LOCKING',
  'V07_REMOTE_LINKED_ACCESS',
  'V08_TSQL_IMPLICIT_EXEC',
  'V09_DELAY_DOS',
  'V10_SESSION_OR_INTERNAL_CMD'
] as const;

export const AttackVectorEnum = z.enum([
  'V01_STACKED_QUERIES',
  'V02_SELECT_INTO',
  'V03_COMMENT_OBFUSCATION',
  'V04_MUTATING_CTE',
  'V05_DANGEROUS_FUNCTIONS',
  'V06_EXPLICIT_LOCKING',
  'V07_REMOTE_LINKED_ACCESS',
  'V08_TSQL_IMPLICIT_EXEC',
  'V09_DELAY_DOS',
  'V10_SESSION_OR_INTERNAL_CMD',
  'CONTROL_VALID_SELECT'
]);

export const RejectionReasonEnum = z.enum([
  'V01_STACKED_QUERIES',
  'V02_SELECT_INTO',
  'V03_COMMENT_OBFUSCATION',
  'V04_MUTATING_CTE',
  'V05_DANGEROUS_FUNCTIONS',
  'V06_EXPLICIT_LOCKING',
  'V07_REMOTE_LINKED_ACCESS',
  'V08_TSQL_IMPLICIT_EXEC',
  'V09_DELAY_DOS',
  'V10_SESSION_OR_INTERNAL_CMD',
  'NON_SELECT_ROOT',
  'SYNTAX_ERROR',
  'EMPTY_QUERY'
]);

export const AdversarialTestCaseSchema = z
  .object({
    id: z.string().regex(/^(ADV-V(0[1-9]|10)-\d{3}|CTL-SEL-\d{3})$/),
    vector: AttackVectorEnum,
    dialect: z.enum(['tsql', 'postgres', 'common']),
    description: z.string().min(10),
    sql: z.string().min(1),
    expectedOutcome: z.enum(['REJECT', 'ALLOW']),
    expectedReasonCode: RejectionReasonEnum.optional()
  })
  .superRefine((val, ctx) => {
    if (val.expectedOutcome === 'REJECT' && !val.expectedReasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expectedReasonCode is required when expectedOutcome === "REJECT"',
        path: ['expectedReasonCode']
      });
    }
    if (val.vector === 'CONTROL_VALID_SELECT' && val.expectedOutcome !== 'ALLOW') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'CONTROL_VALID_SELECT cases must have expectedOutcome === "ALLOW"',
        path: ['expectedOutcome']
      });
    }
    if (val.vector !== 'CONTROL_VALID_SELECT' && val.expectedOutcome !== 'REJECT') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Attack vector cases (V01-V10) must have expectedOutcome === "REJECT"',
        path: ['expectedOutcome']
      });
    }
  });

export const AdversarialCorpusSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    minimumVectorsRequired: z.literal(10),
    cases: z.array(AdversarialTestCaseSchema).min(30)
  })
  .superRefine((corpus, ctx) => {
    const presentVectors = new Set(
      corpus.cases
        .map((c) => c.vector)
        .filter((v): v is AttackVectorId => v !== 'CONTROL_VALID_SELECT')
    );

    for (const requiredVector of MANDATORY_ATTACK_VECTORS) {
      if (!presentVectors.has(requiredVector)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Corpus is missing mandatory attack vector: ${requiredVector}`,
          path: ['cases']
        });
      }
    }

    const ids = new Set<string>();
    for (const testCase of corpus.cases) {
      if (ids.has(testCase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate test case id: ${testCase.id}`,
          path: ['cases']
        });
      }
      ids.add(testCase.id);
    }
  });

export interface AdversarialTestCase {
  readonly id: string;
  readonly vector: AttackVectorId | 'CONTROL_VALID_SELECT';
  readonly dialect: CorpusDialect;
  readonly description: string;
  readonly sql: string;
  readonly expectedOutcome: 'REJECT' | 'ALLOW';
  readonly expectedReasonCode?: RejectionReasonCode;
}

export interface AdversarialCorpus {
  readonly version: string;
  readonly minimumVectorsRequired: 10;
  readonly cases: ReadonlyArray<AdversarialTestCase>;
}
