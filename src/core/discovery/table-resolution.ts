import type { TableMetadata } from '../../contracts/database-adapter.js';
import type { QualifiedName } from '../../contracts/legacy-discovery.contract.js';

export class TableResolutionError extends Error {
  public readonly candidates: ReadonlyArray<string>;

  constructor(message: string, candidates: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'TableResolutionError';
    this.candidates = candidates;
  }
}

/** Parses `schema.table` or `table` (no quoting rules: identifiers come from tool arguments). */
export function parseQualifiedName(raw: string): { schema?: string; table: string } {
  const trimmed = raw.trim();
  const dot = trimmed.lastIndexOf('.');
  if (dot > 0 && dot < trimmed.length - 1) {
    return { schema: trimmed.slice(0, dot), table: trimmed.slice(dot + 1) };
  }
  return { table: trimmed };
}

/**
 * Resolves a possibly unqualified, case-insensitive table reference against the catalog.
 * Exact-case matches win; otherwise ambiguity is reported instead of guessed.
 */
export function resolveTable(
  tables: ReadonlyArray<TableMetadata>,
  ref: { schema?: string; table: string }
): TableMetadata {
  const sameSchema = (t: TableMetadata): boolean =>
    ref.schema === undefined || t.schema.toLowerCase() === ref.schema.toLowerCase();

  const exact = tables.filter((t) => t.name === ref.table && sameSchema(t));
  const pool =
    exact.length > 0
      ? exact
      : tables.filter((t) => t.name.toLowerCase() === ref.table.toLowerCase() && sameSchema(t));

  if (pool.length === 0) {
    throw new TableResolutionError(`Table "${ref.schema ? `${ref.schema}.` : ''}${ref.table}" was not found in the catalog.`);
  }
  if (pool.length > 1) {
    const candidates = pool.map((t) => `${t.schema}.${t.name}`);
    throw new TableResolutionError(
      `Table reference "${ref.table}" is ambiguous; qualify it with a schema.`,
      candidates
    );
  }
  return pool[0] as TableMetadata;
}

export function qualified(name: QualifiedName): string {
  return `${name.schema}.${name.table}`;
}
