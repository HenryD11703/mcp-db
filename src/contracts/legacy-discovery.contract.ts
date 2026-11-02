import type {
  ColumnMetadata,
  ForeignKeyMetadata,
  SchemaCatalog
} from './database-adapter.js';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type StatisticalStatus = 'VERIFIED' | 'SKIPPED' | 'TIMED_OUT' | 'UNAVAILABLE';
export type DiscoveryAuditAction =
  | 'CATALOG_DISCOVERY'
  | 'RELATIONSHIP_INFERENCE'
  | 'GLOSSARY_QUERY';

export interface QualifiedName {
  readonly schema: string;
  readonly table: string;
}

export interface ColumnRef extends QualifiedName {
  readonly column: string;
}

export interface ListTablesRequest {
  readonly schema?: string;
  readonly namePattern?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TableSummary extends QualifiedName {
  readonly kind: 'TABLE' | 'VIEW';
  readonly estimatedRows: number | null;
  readonly glossaryTitle?: string;
}

export interface ListTablesResult {
  readonly tables: ReadonlyArray<TableSummary>;
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface DomainCodeMapping {
  readonly code: string;
  readonly meaning: string;
  readonly deprecated?: boolean;
}

export interface ColumnGlossary {
  readonly meaning: string;
  readonly synonyms: ReadonlyArray<string>;
  readonly domainCodes: ReadonlyArray<DomainCodeMapping>;
}

export interface TableGlossary {
  readonly description: string;
  readonly synonyms: ReadonlyArray<string>;
}

export interface ColumnDetail extends ColumnMetadata {
  readonly maxLength: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
  readonly defaultExpression: string | null;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly indexNames: ReadonlyArray<string>;
  readonly glossary?: ColumnGlossary;
  readonly isSensitive?: boolean;
  readonly sensitiveType?: string;
  readonly isMasked?: boolean;
  readonly sampleValues?: never;
}

export interface TableDetail extends TableSummary {
  readonly columns: ReadonlyArray<ColumnDetail>;
  readonly declaredForeignKeys: ReadonlyArray<ForeignKeyMetadata>;
  readonly glossary?: TableGlossary;
  readonly warnings: ReadonlyArray<string>;
}

export interface InferredRelationship {
  readonly child: ColumnRef;
  readonly parent: ColumnRef;
  readonly score: number;
  readonly level: ConfidenceLevel;
  readonly factors: {
    readonly lexical: number;
    readonly typeCompat: number;
    readonly statistical: number | null;
  };
  readonly statisticalStatus: StatisticalStatus;
  readonly reasons: ReadonlyArray<string>;
  /** Other parent keys that contain all sampled child values equally well (the choice is ambiguous). */
  readonly ambiguousWith?: ReadonlyArray<ColumnRef>;
}

export interface InferRelationshipsRequest {
  readonly tables: ReadonlyArray<QualifiedName>;
  readonly minConfidence?: number;
  readonly verifyStatistically?: boolean;
}

/** Aggregate-only result: raw values never leave the engine (Principles III/IV). */
export interface ContainmentEvidence {
  readonly sampled: number;
  readonly matched: number;
}

export interface CatalogTableExtra extends QualifiedName {
  readonly estimatedRows: number | null;
}

export interface CatalogColumnExtra extends ColumnRef {
  readonly maxLength: number | null;
  readonly precision: number | null;
  readonly scale: number | null;
  readonly defaultExpression: string | null;
}

export interface CatalogIndexExtra extends QualifiedName {
  readonly indexName: string;
  readonly isUnique: boolean;
  readonly isPrimary: boolean;
  readonly columns: ReadonlyArray<string>;
}

/** Engine statistics and index metadata read exclusively from system catalogs. */
export interface CatalogExtras {
  readonly tables: ReadonlyArray<CatalogTableExtra>;
  readonly columns: ReadonlyArray<CatalogColumnExtra>;
  readonly indexes: ReadonlyArray<CatalogIndexExtra>;
}

export interface ContainmentSampleOptions {
  readonly maxSample: number;
  readonly signal?: AbortSignal;
}

/**
 * Optional catalog capabilities of a DatabaseAdapter (Principle VII).
 * Adapters lacking them still work through `introspectSchema` alone.
 */
export interface CatalogCapableAdapter {
  getCatalogExtras(signal?: AbortSignal): Promise<CatalogExtras>;
  /** Bounded sample computed inside the engine; only aggregates are returned. */
  sampleContainment(
    child: ColumnRef,
    parent: ColumnRef,
    options: ContainmentSampleOptions
  ): Promise<ContainmentEvidence>;
  /**
   * Optional: one bounded child sample tested against several unique parent keys in a single
   * round trip. Result order matches `parents`.
   */
  sampleContainmentMany?(
    child: ColumnRef,
    parents: ReadonlyArray<ColumnRef>,
    options: ContainmentSampleOptions
  ): Promise<ReadonlyArray<ContainmentEvidence>>;
}

export function isCatalogCapable<T extends object>(adapter: T): adapter is T & CatalogCapableAdapter {
  const candidate = adapter as Partial<CatalogCapableAdapter>;
  return (
    typeof candidate.getCatalogExtras === 'function' &&
    typeof candidate.sampleContainment === 'function'
  );
}

export interface GlossaryLoadStatus {
  readonly state: 'LOADED' | 'INVALID_KEPT_PREVIOUS' | 'INVALID_NO_PREVIOUS' | 'NOT_CONFIGURED';
  readonly version?: string;
  readonly errorLine?: number;
  readonly errorMessage?: string;
}

export interface GlossarySearchHit {
  readonly table: string;
  readonly column?: string;
  readonly matchedOn: 'table' | 'column' | 'synonym' | 'domainCode';
  readonly excerpt: string;
  readonly score: number;
}

export interface IGlossaryService {
  load(): Promise<GlossaryLoadStatus>;
  status(): GlossaryLoadStatus;
  search(query: string, limit?: number): ReadonlyArray<GlossarySearchHit>;
  enrich(detail: TableDetail): TableDetail;
  tableTitle(schema: string, table: string): string | undefined;
}

export interface CatalogSnapshot {
  readonly catalog: SchemaCatalog;
  readonly extras: CatalogExtras | null;
}

export interface InferenceRunInput {
  readonly snapshot: CatalogSnapshot;
  /** Adapter used for the optional bounded statistical verification. */
  readonly adapter?: object;
  readonly request: InferRelationshipsRequest;
  readonly signal?: AbortSignal;
}

export interface IRelationshipInferenceEngine {
  infer(input: InferenceRunInput): Promise<ReadonlyArray<InferredRelationship>>;
}
