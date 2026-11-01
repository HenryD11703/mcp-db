import type { ConfidenceLevel } from '../../contracts/legacy-discovery.contract.js';
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

export const HIGH_THRESHOLD = 0.85;
export const MEDIUM_THRESHOLD = 0.65;
/** Name + type evidence alone can never reach HIGH confidence. */
export const NO_STATISTICS_CAP = 0.84;

export const WEIGHT_LEXICAL = 0.5;
export const WEIGHT_TYPE = 0.2;
export const WEIGHT_STATISTICAL = 0.3;

export function levelOf(score: number): ConfidenceLevel {
  if (score >= HIGH_THRESHOLD) {
    return 'HIGH';
  }
  if (score >= MEDIUM_THRESHOLD) {
    return 'MEDIUM';
  }
  return 'LOW';
}

type TypeFamily = 'int' | 'numeric' | 'string' | 'uuid' | 'date' | 'bool' | 'other';

export function typeFamily(dataType: string): TypeFamily {
  const t = dataType.toLowerCase().trim();
  if (/^(tinyint|smallint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial)$/.test(t)) {
    return 'int';
  }
  if (/^(numeric|decimal|number|money|smallmoney|float|real|double precision)$/.test(t)) {
    return 'numeric';
  }
  if (/(char|text|string|clob)/.test(t)) {
    return 'string';
  }
  if (/^(uuid|uniqueidentifier)$/.test(t)) {
    return 'uuid';
  }
  if (/(date|time)/.test(t)) {
    return 'date';
  }
  if (/^(bit|bool|boolean)$/.test(t)) {
    return 'bool';
  }
  return 'other';
}

/** Type compatibility 0..1. A value below `TYPE_GATE` discards the candidate. */
export const TYPE_GATE = 0.5;

export function typeCompatibility(childType: string, parentType: string): number {
  const a = typeFamily(childType);
  const b = typeFamily(parentType);
  if (a === 'other' || b === 'other') {
    return childType.toLowerCase() === parentType.toLowerCase() ? 1 : 0;
  }
  if (a === b) {
    return 1;
  }
  if ((a === 'int' && b === 'numeric') || (a === 'numeric' && b === 'int')) {
    return 0.7;
  }
  return 0;
}

export interface LexicalInput {
  readonly childTable: string;
  readonly childColumn: string;
  readonly parentTable: string;
  readonly parentColumn: string;
}

export interface LexicalResult {
  readonly score: number;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Lexical affinity between a candidate child column and a parent key.
 * Generic names (`id`, `status`, `fecha`...) score 0 unless they carry an entity
 * that points to the parent table, so `pedidos.status` never matches `productos.status`.
 */
export function lexicalScore(input: LexicalInput, options: TokenizerOptions = {}): LexicalResult {
  const reasons: string[] = [];
  const columnEntity = entityTokensOfColumn(input.childColumn, options);
  const tableEntity = entityTokensOfTable(input.parentTable);
  const sameName = normalizeName(input.childColumn) === normalizeName(input.parentColumn);
  const parentGeneric = isGenericColumn(input.parentColumn);
  const childGeneric = isGenericColumn(input.childColumn);

  const strength = entityMatchStrength(columnEntity, tableEntity);
  const hasIdMarker = tokenize(input.childColumn).some(isIdToken);

  if (strength > 0) {
    const keyAffinity = sameName ? 1 : parentGeneric && hasIdMarker ? 1 : hasIdMarker ? 0.7 : 0.4;
    reasons.push(
      `Column "${input.childColumn}" refers to entity of table "${input.parentTable}" (strength ${strength.toFixed(2)})`
    );
    if (sameName) {
      reasons.push(`Column name equals parent key "${input.parentColumn}"`);
    } else if (parentGeneric && hasIdMarker) {
      reasons.push(`Id-style column matches generic key "${input.parentColumn}"`);
    }
    return { score: Math.min(1, 0.7 * strength + 0.3 * keyAffinity), reasons };
  }

  if (sameName && !parentGeneric && !childGeneric) {
    reasons.push(`Identical non-generic column name "${input.childColumn}"`);
    return { score: 0.8, reasons };
  }

  return { score: 0, reasons: ['No lexical evidence linking the column to the parent table'] };
}

/** Minimum sampled child values before containment alone is trusted as evidence. */
export const CONTAINMENT_ONLY_MIN_SAMPLE = 10;
export const CONTAINMENT_ONLY_MIN_RATIO = 0.95;
/** Without any name evidence, string keys stay MEDIUM and integer keys LOW (dense ints overlap by chance). */
export const CONTAINMENT_ONLY_STRING_SCORE = 0.75;
export const CONTAINMENT_ONLY_INT_SCORE = 0.6;

/**
 * Score for a candidate backed only by value containment (no lexical link).
 * Returns 0 when the evidence is too thin to be worth reporting.
 */
export function containmentOnlyScore(childType: string, ratio: number, sampled: number): number {
  if (sampled < CONTAINMENT_ONLY_MIN_SAMPLE || ratio < CONTAINMENT_ONLY_MIN_RATIO) {
    return 0;
  }
  return typeFamily(childType) === 'int' ? CONTAINMENT_ONLY_INT_SCORE : CONTAINMENT_ONLY_STRING_SCORE;
}

export interface ScoreInput {
  readonly lexical: number;
  readonly typeCompat: number;
  /** containment ratio in 0..1, or null when no statistical evidence is available */
  readonly statistical: number | null;
}

export function combineScore(input: ScoreInput): number {
  if (input.lexical <= 0 || input.typeCompat < TYPE_GATE) {
    return 0;
  }
  if (input.statistical === null) {
    const base = (WEIGHT_LEXICAL * input.lexical + WEIGHT_TYPE * input.typeCompat) /
      (WEIGHT_LEXICAL + WEIGHT_TYPE);
    return Math.min(NO_STATISTICS_CAP, round2(base));
  }
  return round2(
    Math.min(
      1,
      WEIGHT_LEXICAL * input.lexical + WEIGHT_TYPE * input.typeCompat + WEIGHT_STATISTICAL * input.statistical
    )
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
