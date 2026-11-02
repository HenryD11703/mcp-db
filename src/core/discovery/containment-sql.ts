import type { EngineDialect } from '../../contracts/database-adapter.js';
import type { ColumnRef } from '../../contracts/legacy-discovery.contract.js';

export function quoteIdentifier(dialect: EngineDialect, identifier: string): string {
  if (identifier.length === 0 || identifier.length > 256 || /[\u0000-\u001f]/.test(identifier)) {
    throw new Error('Invalid identifier for catalog sampling.');
  }
  if (dialect === 'postgres') {
    return `"${identifier.replace(/"/g, '""')}"`;
  }
  return `[${identifier.replace(/]/g, ']]')}]`;
}

/**
 * Builds the bounded containment probe. The sample is capped inside the engine
 * (`LIMIT` / `TOP`) and only two aggregate counters are projected, so no row
 * value can ever leave the database through this query.
 * The parent key is required to be unique, hence the LEFT JOIN cannot multiply rows.
 */
export function buildContainmentSql(
  dialect: EngineDialect,
  child: ColumnRef,
  parent: ColumnRef,
  maxSample: number
): string {
  const cap = Math.max(1, Math.min(100, Math.floor(maxSample)));
  const q = (id: string): string => quoteIdentifier(dialect, id);
  const childTable = `${q(child.schema)}.${q(child.table)}`;
  const parentTable = `${q(parent.schema)}.${q(parent.table)}`;

  if (dialect === 'postgres') {
    return (
      `SELECT COUNT(*)::int AS sampled, COUNT(p.${q(parent.column)})::int AS matched ` +
      `FROM (SELECT ${q(child.column)} AS v FROM ${childTable} ` +
      `WHERE ${q(child.column)} IS NOT NULL LIMIT ${cap}) s ` +
      `LEFT JOIN ${parentTable} p ON p.${q(parent.column)} = s.v`
    );
  }
  return (
    `SELECT COUNT(*) AS sampled, COUNT(p.${q(parent.column)}) AS matched ` +
    `FROM (SELECT TOP (${cap}) ${q(child.column)} AS v FROM ${childTable} ` +
    `WHERE ${q(child.column)} IS NOT NULL) s ` +
    `LEFT JOIN ${parentTable} p ON p.${q(parent.column)} = s.v`
  );
}

export const MAX_MULTI_CONTAINMENT_PARENTS = 40;

/**
 * Tests one bounded child sample against several unique parent keys in a single statement.
 * The sample is taken once (`LIMIT` / `TOP`) and each parent adds a LEFT JOIN plus one counter, so the
 * result is a single row of aggregates: `sampled`, `m0`, `m1`, ... (matches per parent, in input order).
 */
export function buildMultiContainmentSql(
  dialect: EngineDialect,
  child: ColumnRef,
  parents: ReadonlyArray<ColumnRef>,
  maxSample: number
): string {
  if (parents.length === 0 || parents.length > MAX_MULTI_CONTAINMENT_PARENTS) {
    throw new Error(`Multi containment probe needs 1..${MAX_MULTI_CONTAINMENT_PARENTS} parents.`);
  }
  const cap = Math.max(1, Math.min(100, Math.floor(maxSample)));
  const q = (id: string): string => quoteIdentifier(dialect, id);
  const childTable = `${q(child.schema)}.${q(child.table)}`;
  const cast = dialect === 'postgres' ? '::int' : '';
  const counters = parents.map((p, i) => `COUNT(p${i}.${q(p.column)})${cast} AS m${i}`).join(', ');
  const joins = parents
    .map((p, i) => `LEFT JOIN ${q(p.schema)}.${q(p.table)} p${i} ON p${i}.${q(p.column)} = s.v`)
    .join(' ');
  const sample =
    dialect === 'postgres'
      ? `SELECT ${q(child.column)} AS v FROM ${childTable} WHERE ${q(child.column)} IS NOT NULL LIMIT ${cap}`
      : `SELECT TOP (${cap}) ${q(child.column)} AS v FROM ${childTable} WHERE ${q(child.column)} IS NOT NULL`;
  return `SELECT COUNT(*)${cast} AS sampled, ${counters} FROM (${sample}) s ${joins}`;
}
