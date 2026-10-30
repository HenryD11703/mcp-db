import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type {
  ColumnDetail,
  GlossaryLoadStatus,
  GlossarySearchHit,
  IGlossaryService,
  QualifiedName,
  TableDetail
} from '../../contracts/legacy-discovery.contract.js';
import { GlossaryIndex, normalizeText } from './glossary-index.js';
import {
  formatFromPath,
  GlossaryParseError,
  parseGlossaryText,
  type GlossaryDocument,
  type GlossaryTableEntry
} from './glossary-loader.js';

export const DEFAULT_GLOSSARY_CANDIDATES: ReadonlyArray<string> = [
  'docs/glossary.yaml',
  'docs/glossary.yml',
  'docs/glossary.json'
];
export const DEFAULT_MAX_GLOSSARY_BYTES = 1024 * 1024;

export interface GlossaryServiceOptions {
  /** Explicit path (e.g. from `GLOSSARY_PATH`). When absent, the default candidates are probed. */
  readonly filePath?: string;
  readonly cwd?: string;
  readonly maxBytes?: number;
  readonly debounceMs?: number;
  readonly onReload?: (status: GlossaryLoadStatus) => void;
}

export class GlossaryService implements IGlossaryService {
  private readonly explicitPath: string | undefined;
  private readonly cwd: string;
  private readonly maxBytes: number;
  private readonly debounceMs: number;
  private readonly onReload: ((status: GlossaryLoadStatus) => void) | undefined;

  private resolvedPath: string | undefined;
  private doc: GlossaryDocument | undefined;
  private index: GlossaryIndex | undefined;
  private byKey = new Map<string, GlossaryTableEntry>();
  private current: GlossaryLoadStatus = { state: 'NOT_CONFIGURED' };
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: GlossaryServiceOptions = {}) {
    this.explicitPath = options.filePath;
    this.cwd = options.cwd ?? process.cwd();
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_GLOSSARY_BYTES;
    this.debounceMs = options.debounceMs ?? 50;
    this.onReload = options.onReload;
  }

  public status(): GlossaryLoadStatus {
    return this.current;
  }

  public async load(): Promise<GlossaryLoadStatus> {
    const path = this.locate();
    if (!path) {
      this.current = { state: 'NOT_CONFIGURED' };
      return this.current;
    }
    this.resolvedPath = path;

    try {
      const info = await stat(path);
      if (info.size > this.maxBytes) {
        throw new GlossaryParseError(
          `Glossary file exceeds the maximum size of ${this.maxBytes} bytes.`
        );
      }
      const text = await readFile(path, 'utf8');
      const doc = parseGlossaryText(text, formatFromPath(path));
      this.install(doc);
      this.current = { state: 'LOADED', version: doc.version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const line = err instanceof GlossaryParseError ? err.line : undefined;
      this.current = {
        state: this.doc ? 'INVALID_KEPT_PREVIOUS' : 'INVALID_NO_PREVIOUS',
        ...(this.doc ? { version: this.doc.version } : {}),
        ...(line !== undefined ? { errorLine: line } : {}),
        errorMessage: message
      };
    }
    return this.current;
  }

  /** Watches the glossary directory (robust to editors that replace files atomically). */
  public watch(): void {
    if (this.watcher) {
      return;
    }
    const path = this.resolvedPath ?? this.locate();
    if (!path) {
      return;
    }
    const target = basename(path);
    this.watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename && filename.toString() !== target) {
        return;
      }
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.timer = setTimeout(() => {
        void this.load().then((status) => this.onReload?.(status));
      }, this.debounceMs);
    });
  }

  public close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  public search(query: string, limit = 10): ReadonlyArray<GlossarySearchHit> {
    return this.index ? this.index.search(query, limit) : [];
  }

  public tableTitle(schema: string, table: string): string | undefined {
    const entry = this.findEntry(schema, table);
    return entry ? entry.description : undefined;
  }

  /** Glossary tables that no longer exist in the physical catalog. */
  public staleReferences(tables: ReadonlyArray<QualifiedName>): ReadonlyArray<string> {
    if (!this.doc) {
      return [];
    }
    const known = new Set<string>();
    for (const t of tables) {
      known.add(normalizeText(t.table));
      known.add(normalizeText(`${t.schema}.${t.table}`));
    }
    return this.doc.tables
      .filter((e) => !known.has(normalizeText(e.table)))
      .map((e) => `stale_glossary_reference: table "${e.table}" documented in the glossary does not exist in the catalog.`);
  }

  public enrich(detail: TableDetail): TableDetail {
    const warnings = [...detail.warnings];
    if (this.current.state === 'INVALID_KEPT_PREVIOUS') {
      warnings.push(
        `Glossary reload failed${this.current.errorLine ? ` at line ${this.current.errorLine}` : ''}; serving the last valid version ${this.current.version ?? ''}.`
      );
    }
    const entry = this.findEntry(detail.schema, detail.table);
    if (!entry) {
      return { ...detail, warnings };
    }

    const physical = new Map(detail.columns.map((c) => [normalizeText(c.name), c]));
    const glossaryByColumn = new Map(entry.columns.map((c) => [normalizeText(c.column), c]));
    for (const col of entry.columns) {
      if (!physical.has(normalizeText(col.column))) {
        warnings.push(
          `stale_glossary_reference: column "${col.column}" documented in the glossary does not exist in ${detail.schema}.${detail.table}.`
        );
      }
    }

    const columns: ColumnDetail[] = detail.columns.map((col) => {
      const g = glossaryByColumn.get(normalizeText(col.name));
      if (!g) {
        return col;
      }
      return {
        ...col,
        glossary: {
          meaning: g.meaning,
          synonyms: g.synonyms,
          domainCodes: g.domainCodes.map((d) => ({
            code: d.code,
            meaning: d.meaning,
            ...(d.deprecated !== undefined ? { deprecated: d.deprecated } : {})
          }))
        }
      };
    });

    return {
      ...detail,
      columns,
      glossary: { description: entry.description, synonyms: entry.synonyms },
      warnings
    };
  }

  private locate(): string | undefined {
    if (this.explicitPath) {
      return resolve(this.cwd, this.explicitPath);
    }
    for (const candidate of DEFAULT_GLOSSARY_CANDIDATES) {
      const full = resolve(this.cwd, candidate);
      if (existsSync(full)) {
        return full;
      }
    }
    return undefined;
  }

  private install(doc: GlossaryDocument): void {
    this.doc = doc;
    this.index = new GlossaryIndex(doc);
    this.byKey = new Map(doc.tables.map((t) => [normalizeText(t.table), t]));
  }

  private findEntry(schema: string, table: string): GlossaryTableEntry | undefined {
    return (
      this.byKey.get(normalizeText(`${schema}.${table}`)) ?? this.byKey.get(normalizeText(table))
    );
  }
}
