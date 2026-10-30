import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function safeText(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !CONTROL_CHARS.test(v), { message: 'control characters are not allowed' });
}

const synonymsSchema = z.array(safeText(100)).max(20).default([]);

const domainCodeSchema = z
  .object({
    code: safeText(64, 1),
    meaning: safeText(300),
    deprecated: z.boolean().optional()
  })
  .strict();

const columnSchema = z
  .object({
    column: safeText(256, 1),
    meaning: safeText(500),
    synonyms: synonymsSchema,
    domainCodes: z.array(domainCodeSchema).max(200).default([])
  })
  .strict();

const tableSchema = z
  .object({
    table: safeText(256, 1),
    description: safeText(1000),
    synonyms: synonymsSchema,
    columns: z.array(columnSchema).max(500).default([])
  })
  .strict();

export const glossaryDocumentSchema = z
  .object({
    version: safeText(32, 1),
    tables: z.array(tableSchema).max(5000)
  })
  .strict();

export type GlossaryDocument = z.infer<typeof glossaryDocumentSchema>;
export type GlossaryTableEntry = GlossaryDocument['tables'][number];
export type GlossaryColumnEntry = GlossaryTableEntry['columns'][number];

export class GlossaryParseError extends Error {
  public readonly line: number | undefined;

  constructor(message: string, line?: number) {
    super(message);
    this.name = 'GlossaryParseError';
    this.line = line;
  }
}

export type GlossaryFormat = 'yaml' | 'json';

export function formatFromPath(filePath: string): GlossaryFormat {
  return filePath.toLowerCase().endsWith('.json') ? 'json' : 'yaml';
}

function lineFromJsonError(text: string, message: string): number | undefined {
  const match = /position (\d+)/.exec(message);
  if (!match) {
    return undefined;
  }
  const pos = Number(match[1]);
  return text.slice(0, pos).split('\n').length;
}

function formatIssues(issues: ReadonlyArray<z.ZodIssue>): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Parses and validates glossary text, reporting the offending line when it can be located. */
export function parseGlossaryText(text: string, format: GlossaryFormat): GlossaryDocument {
  if (format === 'json') {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GlossaryParseError(`Invalid JSON: ${message}`, lineFromJsonError(text, message));
    }
    const result = glossaryDocumentSchema.safeParse(raw);
    if (!result.success) {
      throw new GlossaryParseError(`Invalid glossary: ${formatIssues(result.error.issues)}`);
    }
    return result.data;
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, merge: false });
  const firstError = doc.errors[0];
  if (firstError) {
    throw new GlossaryParseError(
      `Invalid YAML: ${firstError.message.split('\n')[0] ?? firstError.message}`,
      firstError.linePos?.[0]?.line
    );
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: 0 });
  } catch (err) {
    throw new GlossaryParseError(
      `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
  const result = glossaryDocumentSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    let line: number | undefined;
    if (first) {
      const node = doc.getIn(first.path, true) as { range?: [number, number, number] } | undefined;
      const offset = node?.range?.[0];
      if (typeof offset === 'number') {
        line = lineCounter.linePos(offset).line;
      }
    }
    throw new GlossaryParseError(`Invalid glossary: ${formatIssues(result.error.issues)}`, line);
  }
  return result.data;
}
