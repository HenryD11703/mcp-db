import type { TableMetadata } from '../../contracts/database-adapter.js';
import {
  isCatalogCapable,
  type CatalogCapableAdapter,
  type CatalogSnapshot,
  type ColumnRef,
  type InferenceRunInput,
  type InferredRelationship,
  type IRelationshipInferenceEngine,
  type StatisticalStatus
} from '../../contracts/legacy-discovery.contract.js';
import {
  entityMatchStrength,
  entityTokensOfColumn,
  entityTokensOfTable,
  isGenericColumn,
  isIdToken,
  normalizeName,
  tokenize,
  type TokenizerOptions
} from './name-tokenizer.js';
import {
  combineScore,
  containmentOnlyScore,
  levelOf,
  lexicalScore,
  typeCompatibility,
  typeFamily,
  TYPE_GATE
} from './inference-scoring.js';
import { MAX_MULTI_CONTAINMENT_PARENTS } from './containment-sql.js';
import { parseQualifiedName, resolveTable } from './table-resolution.js';

export interface RelationshipInferenceOptions extends TokenizerOptions {
  readonly sampleTimeoutMs?: number;
  readonly maxSample?: number;
  readonly maxSamplings?: number;
  readonly defaultMinConfidence?: number;
  readonly maxResults?: number;
  /** Extra sampling budget for columns with no name evidence (value-containment-only discovery). */
  readonly maxContainmentOnlySamplings?: number;
}

interface ParentKey {
  readonly table: TableMetadata;
  readonly column: string;
  readonly dataType: string;
  readonly source: 'PRIMARY_KEY' | 'UNIQUE_INDEX';
  readonly entity: ReadonlyArray<string>;
  readonly normalizedName: string;
}

interface Candidate {
  child: ColumnRef;
  parent: ColumnRef;
  parentTable: TableMetadata;
  lexical: number;
  typeCompat: number;
  reasons: string[];
  prelim: number;
}

/** A column whose values fit more parents than this carries no usable signal. */
const MAX_REPORTED_TIES = 5;
const TIE_PENALTY = 0.05;

function parentRef(p: ParentKey): ColumnRef {
  return { schema: p.table.schema, table: p.table.name, column: p.column };
}

const SAMPLING_FLOOR = 0.5;
const SAMPLING_MARGIN = 0.15;
/** Minimum sampled values needed before a low containment ratio discards the candidate. */
const MIN_EVIDENCE_FOR_DISCARD = 5;

function keyOf(schema: string, table: string): string {
  return `${schema}\u0000${table}`;
}

export class RelationshipInferenceEngine implements IRelationshipInferenceEngine {
  private readonly sampleTimeoutMs: number;
  private readonly maxSample: number;
  private readonly maxSamplings: number;
  private readonly defaultMinConfidence: number;
  private readonly maxResults: number;
  private readonly maxContainmentOnlySamplings: number;
  private readonly tokenizerOptions: TokenizerOptions;

  constructor(options: RelationshipInferenceOptions = {}) {
    this.sampleTimeoutMs = options.sampleTimeoutMs ?? 1000;
    this.maxSample = Math.min(100, options.maxSample ?? 100);
    this.maxSamplings = options.maxSamplings ?? 150;
    this.defaultMinConfidence = options.defaultMinConfidence ?? 0.7;
    this.maxResults = options.maxResults ?? 200;
    this.maxContainmentOnlySamplings = options.maxContainmentOnlySamplings ?? 400;
    this.tokenizerOptions = options.abbreviations ? { abbreviations: options.abbreviations } : {};
  }

  public async infer(input: InferenceRunInput): Promise<ReadonlyArray<InferredRelationship>> {
    const { snapshot, request, signal } = input;
    const minConfidence = request.minConfidence ?? this.defaultMinConfidence;
    const verify = request.verifyStatistically ?? true;
    const tables = snapshot.catalog.tables;

    const requested = new Set<string>();
    for (const ref of request.tables) {
      const t = resolveTable(tables, { table: ref.table, ...(ref.schema ? { schema: ref.schema } : {}) });
      requested.add(keyOf(t.schema, t.name));
    }

    const declared = this.declaredChildColumns(snapshot);
    const parentKeys = this.collectParentKeys(snapshot);
    const candidates = this.generateCandidates(tables, parentKeys, requested, declared);

    candidates.sort((a, b) => b.prelim - a.prelim);

    const adapter = input.adapter;
    const canSample = verify && adapter !== undefined && isCatalogCapable(adapter);
    let samplings = 0;
    const results: InferredRelationship[] = [];

    for (const cand of candidates) {
      if (signal?.aborted) {
        break;
      }
      let status: StatisticalStatus = 'SKIPPED';
      let statistical: number | null = null;
      let score = cand.prelim;
      const reasons = [...cand.reasons];

      const worthSampling =
        cand.prelim >= Math.max(SAMPLING_FLOOR, minConfidence - SAMPLING_MARGIN) ||
        cand.prelim >= minConfidence;

      if (canSample && worthSampling && samplings < this.maxSamplings) {
        samplings += 1;
        const outcome = await this.sample(adapter, cand, signal);
        status = outcome.status;
        if (outcome.status === 'VERIFIED') {
          statistical = outcome.ratio;
          score = combineScore({ lexical: cand.lexical, typeCompat: cand.typeCompat, statistical });
          reasons.push(
            `Sampled ${outcome.sampled} values: ${(outcome.ratio * 100).toFixed(0)}% exist in the parent key`
          );
          if (outcome.sampled >= MIN_EVIDENCE_FOR_DISCARD && outcome.ratio < 0.5) {
            continue; // domain containment contradicts the naming hypothesis
          }
          if (outcome.ratio < 0.9) {
            score = Math.min(score, 0.7);
            reasons.push('Partial containment caps the confidence');
          }
        } else if (outcome.status === 'TIMED_OUT') {
          reasons.push('Statistical verification timed out; confidence limited to name and type evidence');
        } else {
          reasons.push('Statistical verification unavailable; confidence limited to name and type evidence');
        }
      } else if (!canSample && verify) {
        status = 'UNAVAILABLE';
      }

      if (score < minConfidence || score <= 0) {
        continue;
      }
      results.push({
        child: cand.child,
        parent: cand.parent,
        score,
        level: levelOf(score),
        factors: {
          lexical: round2(cand.lexical),
          typeCompat: round2(cand.typeCompat),
          statistical: statistical === null ? null : round2(statistical)
        },
        statisticalStatus: status,
        reasons
      });
    }

    if (canSample) {
      results.push(
        ...(await this.inferByContainmentOnly(adapter, tables, parentKeys, requested, declared, candidates, minConfidence, signal))
      );
    }

    results.sort(
      (a, b) =>
        b.score - a.score ||
        `${a.child.table}.${a.child.column}`.localeCompare(`${b.child.table}.${b.child.column}`)
    );
    return results.slice(0, this.maxResults);
  }

  /**
   * Second pass for child columns that no name rule linked to any parent (e.g. `cod_jefe` -> `cod_usr`,
   * a self-reference, or `cliente` -> `cod_cli`). Each eligible child column is tested against every
   * same-family unique key in one round trip when the adapter supports it. The only evidence is that
   * the sampled child values exist in the parent key, so scores stay modest, and when several parents
   * fit equally well the result is reported as ambiguous instead of picking one.
   */
  private async inferByContainmentOnly(
    adapter: object,
    tables: ReadonlyArray<TableMetadata>,
    parentKeys: ReadonlyArray<ParentKey>,
    requested: ReadonlySet<string>,
    declared: ReadonlySet<string>,
    named: ReadonlyArray<Candidate>,
    minConfidence: number,
    signal?: AbortSignal
  ): Promise<InferredRelationship[]> {
    const withNameEvidence = new Set(
      named.map((c) => `${c.child.schema}\u0000${c.child.table}\u0000${c.child.column}`)
    );
    const groups: Array<{ child: ColumnRef; childType: string; idLike: boolean; parents: ParentKey[] }> = [];

    for (const table of tables) {
      if (table.kind !== 'TABLE' || !requested.has(keyOf(table.schema, table.name))) {
        continue;
      }
      for (const col of table.columns) {
        const colKey = `${table.schema}\u0000${table.name}\u0000${col.name}`;
        if (declared.has(colKey) || withNameEvidence.has(colKey) || isGenericColumn(col.name)) {
          continue;
        }
        if (table.primaryKeyColumns.length === 1 && table.primaryKeyColumns[0] === col.name) {
          continue; // the table's own identity, not a reference
        }
        const family = typeFamily(col.dataType);
        if (family !== 'int' && family !== 'string' && family !== 'uuid') {
          continue;
        }
        const idLike = tokenizeHasId(col.name);
        if (family === 'int' && !idLike) {
          continue; // plain integers (quantities, lines) overlap dense keys by chance
        }
        const parents = parentKeys.filter(
          (p) =>
            typeFamily(p.dataType) === family &&
            !(p.table.schema === table.schema && p.table.name === table.name && p.column === col.name)
        );
        if (parents.length > 0) {
          groups.push({ child: { schema: table.schema, table: table.name, column: col.name }, childType: col.dataType, idLike, parents });
        }
      }
    }

    groups.sort((a, b) => Number(b.idLike) - Number(a.idLike));
    const many = isCatalogCapable(adapter) ? adapter.sampleContainmentMany?.bind(adapter) : undefined;
    const out: InferredRelationship[] = [];
    let budget = this.maxContainmentOnlySamplings;

    for (const group of groups) {
      if (budget <= 0 || signal?.aborted) {
        break;
      }
      const evidence = new Map<ParentKey, { sampled: number; ratio: number }>();

      for (let i = 0; i < group.parents.length && budget > 0; i += MAX_MULTI_CONTAINMENT_PARENTS) {
        const chunk = group.parents.slice(i, i + MAX_MULTI_CONTAINMENT_PARENTS);
        const refs = chunk.map(parentRef);
        let results: ReadonlyArray<{ sampled: number; matched: number }> | undefined;
        if (many) {
          budget -= 1;
          results = await this.sampleMany(many, group.child, refs, signal);
        }
        if (!results) {
          // Adapter without the batch probe, or the batch failed (e.g. collation mismatch): pair by pair.
          const pairwise: Array<{ sampled: number; matched: number }> = [];
          for (const ref of refs) {
            if (budget <= 0) {
              break;
            }
            budget -= 1;
            const one = await this.sample(adapter, { child: group.child, parent: ref } as Candidate, signal);
            pairwise.push(one.status === 'VERIFIED' ? { sampled: one.sampled, matched: Math.round(one.ratio * one.sampled) } : { sampled: 0, matched: 0 });
          }
          results = pairwise;
        }
        results.forEach((r, k) => {
          if (r.sampled > 0) {
            evidence.set(chunk[k]!, { sampled: r.sampled, ratio: Math.max(0, Math.min(1, r.matched / r.sampled)) });
          }
        });
      }

      const hits = [...evidence.entries()]
        .map(([parent, e]) => ({ parent, ...e, score: containmentOnlyScore(group.childType, e.ratio, e.sampled) }))
        .filter((h) => h.score > 0);
      if (hits.length === 0 || hits.length > MAX_REPORTED_TIES) {
        continue; // nothing found, or so many parents fit that the evidence says nothing
      }
      const tied = hits.length > 1;
      for (const hit of hits) {
        const score = tied ? round2(hit.score - TIE_PENALTY) : hit.score;
        if (score < minConfidence) {
          continue;
        }
        const alternatives = hits.filter((h) => h !== hit).map((h) => parentRef(h.parent));
        out.push({
          child: group.child,
          parent: parentRef(hit.parent),
          score,
          level: levelOf(score),
          factors: { lexical: 0, typeCompat: 1, statistical: round2(hit.ratio) },
          statisticalStatus: 'VERIFIED',
          reasons: [
            'No name evidence: inferred only from value containment',
            `Sampled ${hit.sampled} values: ${(hit.ratio * 100).toFixed(0)}% exist in the parent key`,
            hit.parent.source === 'PRIMARY_KEY' ? 'Parent column is the primary key' : 'Parent column has a unique index',
            ...(tied
              ? [`Ambiguous: ${hits.length} parent keys contain every sampled value (${hits.map((h) => `${h.parent.table.name}.${h.parent.column}`).join(', ')})`]
              : [])
          ],
          ...(tied ? { ambiguousWith: alternatives } : {})
        });
      }
    }
    return out;
  }

  private async sampleMany(
    many: NonNullable<CatalogCapableAdapter['sampleContainmentMany']>,
    child: ColumnRef,
    parents: ReadonlyArray<ColumnRef>,
    external?: AbortSignal
  ): Promise<ReadonlyArray<{ sampled: number; matched: number }> | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.sampleTimeoutMs * 2);
    const onExternal = (): void => controller.abort();
    external?.addEventListener('abort', onExternal, { once: true });
    try {
      return await many(child, parents, { maxSample: this.maxSample, signal: controller.signal });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    }
  }

  private declaredChildColumns(snapshot: CatalogSnapshot): Set<string> {
    const declared = new Set<string>();
    for (const fk of snapshot.catalog.foreignKeys) {
      declared.add(`${fk.sourceSchema}\u0000${fk.sourceTable}\u0000${fk.sourceColumn}`);
    }
    return declared;
  }

  private collectParentKeys(snapshot: CatalogSnapshot): ParentKey[] {
    const keys: ParentKey[] = [];
    const uniqueSingle = new Map<string, Set<string>>();
    for (const idx of snapshot.extras?.indexes ?? []) {
      if (idx.isUnique && idx.columns.length === 1 && idx.columns[0] !== undefined) {
        const k = keyOf(idx.schema, idx.table);
        const set = uniqueSingle.get(k) ?? new Set<string>();
        set.add(idx.columns[0]);
        uniqueSingle.set(k, set);
      }
    }

    for (const table of snapshot.catalog.tables) {
      if (table.kind !== 'TABLE') {
        continue;
      }
      const entity = entityTokensOfTable(table.name);
      const columnsByName = new Map(table.columns.map((c) => [c.name, c]));
      const names = new Map<string, 'PRIMARY_KEY' | 'UNIQUE_INDEX'>();
      if (table.primaryKeyColumns.length === 1 && table.primaryKeyColumns[0] !== undefined) {
        names.set(table.primaryKeyColumns[0], 'PRIMARY_KEY');
      }
      for (const name of uniqueSingle.get(keyOf(table.schema, table.name)) ?? []) {
        if (!names.has(name)) {
          names.set(name, 'UNIQUE_INDEX');
        }
      }
      for (const [name, source] of names) {
        const col = columnsByName.get(name);
        if (!col) {
          continue;
        }
        keys.push({
          table,
          column: name,
          dataType: col.dataType,
          source,
          entity,
          normalizedName: normalizeName(name)
        });
      }
    }
    return keys;
  }

  private generateCandidates(
    tables: ReadonlyArray<TableMetadata>,
    parentKeys: ReadonlyArray<ParentKey>,
    requested: ReadonlySet<string>,
    declared: ReadonlySet<string>
  ): Candidate[] {
    const out: Candidate[] = [];
    const seen = new Set<string>();

    for (const child of tables) {
      const childRequested = requested.has(keyOf(child.schema, child.name));
      for (const col of child.columns) {
        if (declared.has(`${child.schema}\u0000${child.name}\u0000${col.name}`)) {
          continue;
        }
        const columnEntity = entityTokensOfColumn(col.name, this.tokenizerOptions);
        const normalizedColumn = normalizeName(col.name);
        const columnGeneric = isGenericColumn(col.name);
        // `id_aud_imp` as the sole PK of AUD_IMP is that table's own identity; pairing it with the key of a
        // twin table (AUD_IMP2) is a naming coincidence, not a reference.
        if (
          child.primaryKeyColumns.length === 1 &&
          child.primaryKeyColumns[0] === col.name &&
          columnEntity.length > 0 &&
          [entityTokensOfTable(child.name), entityTokensOfColumn(child.name, this.tokenizerOptions)].some(
            (own) => own.join('') === columnEntity.join('')
          )
        ) {
          continue;
        }

        for (const pk of parentKeys) {
          if (pk.table.schema === child.schema && pk.table.name === child.name) {
            continue;
          }
          const parentRequested = requested.has(keyOf(pk.table.schema, pk.table.name));
          if (!childRequested && !parentRequested) {
            continue;
          }

          const strength = entityMatchStrength(columnEntity, pk.entity);
          const sameName = normalizedColumn === pk.normalizedName;
          const extendsKey = !columnGeneric && !isGenericColumn(pk.column) && normalizedColumn.startsWith(`${pk.normalizedName}_`);
          if (strength === 0 && !extendsKey && !(sameName && !columnGeneric && !isGenericColumn(pk.column))) {
            continue;
          }

          const typeCompat = typeCompatibility(col.dataType, pk.dataType);
          if (typeCompat < TYPE_GATE) {
            continue;
          }

          const lex = lexicalScore(
            {
              childTable: child.name,
              childColumn: col.name,
              parentTable: pk.table.name,
              parentColumn: pk.column
            },
            this.tokenizerOptions
          );
          if (lex.score <= 0) {
            continue;
          }

          const dedupe = `${child.schema}\u0000${child.name}\u0000${col.name}\u0000${pk.table.schema}\u0000${pk.table.name}\u0000${pk.column}`;
          if (seen.has(dedupe)) {
            continue;
          }
          seen.add(dedupe);

          const prelim = combineScore({ lexical: lex.score, typeCompat, statistical: null });
          if (prelim <= 0) {
            continue;
          }
          out.push({
            child: { schema: child.schema, table: child.name, column: col.name },
            parent: { schema: pk.table.schema, table: pk.table.name, column: pk.column },
            parentTable: pk.table,
            lexical: lex.score,
            typeCompat,
            reasons: [
              ...lex.reasons,
              `Types "${col.dataType}" and "${pk.dataType}" are compatible`,
              pk.source === 'PRIMARY_KEY'
                ? 'Parent column is the primary key'
                : 'Parent column has a unique index'
            ],
            prelim
          });
        }
      }
    }

    // Keep only the best parent per child column to avoid noise from look-alike tables.
    const best = new Map<string, Candidate>();
    for (const c of out) {
      const k = `${c.child.schema}\u0000${c.child.table}\u0000${c.child.column}`;
      const current = best.get(k);
      if (!current || c.prelim > current.prelim) {
        best.set(k, c);
      }
    }
    // Ties between several parents are legitimate: re-add equal-score alternatives.
    const result: Candidate[] = [];
    for (const c of out) {
      const k = `${c.child.schema}\u0000${c.child.table}\u0000${c.child.column}`;
      const top = best.get(k);
      if (top && c.prelim >= top.prelim - 0.05) {
        result.push(c);
      }
    }
    return result;
  }

  private async sample(
    adapter: object,
    cand: Candidate,
    external?: AbortSignal
  ): Promise<
    | { status: 'VERIFIED'; ratio: number; sampled: number }
    | { status: 'TIMED_OUT' | 'UNAVAILABLE' }
  > {
    if (!isCatalogCapable(adapter)) {
      return { status: 'UNAVAILABLE' };
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.sampleTimeoutMs);
    const onExternal = (): void => controller.abort();
    external?.addEventListener('abort', onExternal, { once: true });

    try {
      const evidence = await adapter.sampleContainment(cand.child, cand.parent, {
        maxSample: this.maxSample,
        signal: controller.signal
      });
      if (evidence.sampled <= 0) {
        return { status: 'UNAVAILABLE' };
      }
      return {
        status: 'VERIFIED',
        ratio: Math.max(0, Math.min(1, evidence.matched / evidence.sampled)),
        sampled: evidence.sampled
      };
    } catch {
      return { status: timedOut ? 'TIMED_OUT' : 'UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternal);
    }
  }
}

function tokenizeHasId(name: string): boolean {
  return tokenize(name).some(isIdToken);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function parseRequestedTables(
  refs: ReadonlyArray<string>
): ReadonlyArray<{ schema: string; table: string }> {
  return refs.map((raw) => {
    const parsed = parseQualifiedName(raw);
    return { schema: parsed.schema ?? '', table: parsed.table };
  });
}
