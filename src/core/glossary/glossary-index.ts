import type { GlossarySearchHit } from '../../contracts/legacy-discovery.contract.js';
import type { GlossaryDocument } from './glossary-loader.js';

export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function textTokens(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

/** Light stemming through shared prefixes: `morosidad` ~ `moroso`. */
export function tokenMatches(queryToken: string, fieldToken: string): boolean {
  if (queryToken === fieldToken) {
    return true;
  }
  const minLen = Math.min(queryToken.length, fieldToken.length);
  if (minLen < 4) {
    return false;
  }
  return commonPrefixLength(queryToken, fieldToken) >= Math.max(4, minLen - 3);
}

interface IndexedField {
  readonly table: string;
  readonly column?: string;
  readonly matchedOn: GlossarySearchHit['matchedOn'];
  readonly weight: number;
  readonly text: string;
  readonly tokens: ReadonlyArray<string>;
  readonly exact: string;
}

function excerptOf(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** In-memory lexical index over table, column, synonym and domain-code text. */
export class GlossaryIndex {
  private readonly fields: ReadonlyArray<IndexedField>;

  constructor(doc: GlossaryDocument) {
    const fields: IndexedField[] = [];
    const add = (
      table: string,
      column: string | undefined,
      matchedOn: IndexedField['matchedOn'],
      weight: number,
      text: string
    ): void => {
      fields.push({
        table,
        ...(column !== undefined ? { column } : {}),
        matchedOn,
        weight,
        text,
        tokens: textTokens(text),
        exact: normalizeText(text).trim()
      });
    };

    for (const t of doc.tables) {
      add(t.table, undefined, 'table', 1, t.table);
      add(t.table, undefined, 'table', 0.6, t.description);
      for (const s of t.synonyms) {
        add(t.table, undefined, 'synonym', 0.9, s);
      }
      for (const c of t.columns) {
        add(t.table, c.column, 'column', 0.8, c.column);
        add(t.table, c.column, 'column', 0.6, c.meaning);
        for (const s of c.synonyms) {
          add(t.table, c.column, 'synonym', 0.9, s);
        }
        for (const d of c.domainCodes) {
          add(t.table, c.column, 'domainCode', 1, d.code);
          add(t.table, c.column, 'domainCode', 0.7, `${d.code} ${d.meaning}`);
        }
      }
    }
    this.fields = fields;
  }

  public search(query: string, limit = 10): GlossarySearchHit[] {
    const queryTokens = textTokens(query);
    if (queryTokens.length === 0) {
      return [];
    }
    const exactQuery = normalizeText(query).trim();
    const best = new Map<string, GlossarySearchHit>();

    for (const field of this.fields) {
      let matched = 0;
      for (const q of queryTokens) {
        if (field.tokens.some((ft) => tokenMatches(q, ft))) {
          matched += 1;
        }
      }
      if (matched === 0) {
        continue;
      }
      let score = (matched / queryTokens.length) * field.weight;
      if (field.exact === exactQuery) {
        score = Math.min(1, score + 0.2);
      }
      const key = `${field.table}\u0000${field.column ?? ''}`;
      const current = best.get(key);
      if (!current || score > current.score) {
        best.set(key, {
          table: field.table,
          ...(field.column !== undefined ? { column: field.column } : {}),
          matchedOn: field.matchedOn,
          excerpt: excerptOf(field.text),
          score: Math.round(score * 100) / 100
        });
      }
    }

    return [...best.values()]
      .sort((a, b) => b.score - a.score || a.table.localeCompare(b.table))
      .slice(0, Math.max(1, limit));
  }
}
