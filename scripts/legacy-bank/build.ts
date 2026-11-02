import { TABLES, makeRng, type RowContext } from './schema.js';

export type EngineKind = 'mysql' | 'postgres' | 'sqlserver' | 'sqlite';

function sqlType(engine: EngineKind, type: string, length?: number): string {
  switch (type) {
    case 'id':
      if (engine === 'mysql') return 'INT AUTO_INCREMENT PRIMARY KEY';
      if (engine === 'postgres') return 'SERIAL PRIMARY KEY';
      if (engine === 'sqlserver') return 'INT IDENTITY(1,1) PRIMARY KEY';
      return 'INTEGER PRIMARY KEY AUTOINCREMENT';
    case 'fk':
    case 'int':
      return engine === 'sqlite' ? 'INTEGER' : 'INT';
    case 'bool':
      if (engine === 'sqlite') return 'INTEGER';
      if (engine === 'postgres') return 'INT';
      return engine === 'sqlserver' ? 'BIT' : 'TINYINT';
    case 'amount':
      return engine === 'sqlite' ? 'REAL' : 'DECIMAL(14,2)';
    case 'date':
      return engine === 'sqlite' ? 'TEXT' : 'DATE';
    case 'datetime':
      if (engine === 'sqlite') return 'TEXT';
      if (engine === 'sqlserver') return 'DATETIME2';
      if (engine === 'postgres') return 'TIMESTAMP';
      return 'DATETIME';
    case 'text':
      return engine === 'sqlite' ? 'TEXT' : 'TEXT';
    default: {
      const len = length ?? 255;
      if (engine === 'sqlite') return 'TEXT';
      return `VARCHAR(${len})`;
    }
  }
}

export function buildDdl(engine: EngineKind): string[] {
  const statements: string[] = [];
  for (const table of TABLES) {
    const cols = table.columns.map((c) => `  ${quoteIdent(engine, c.name)} ${sqlType(engine, c.type, c.length)}`);
    statements.push(`CREATE TABLE ${quoteIdent(engine, table.name)} (\n${cols.join(',\n')}\n)`);
  }
  return statements;
}

function quoteIdent(engine: EngineKind, name: string): string {
  if (engine === 'sqlserver') return `[${name}]`;
  // Deliberately unquoted on Postgres: quoting would preserve case (e.g. "correoElectronico"),
  // but every cross-engine validation query is written unquoted and Postgres folds unquoted
  // identifiers to lowercase -- quoting here would make DDL and DML identifiers disagree.
  return name;
}

export interface GeneratedRow {
  readonly table: string;
  readonly columns: string[];
  readonly values: (string | number | null)[];
}

/** Deterministic generation shared by every engine so cross-engine data matches 1:1. */
export function* generateAllRows(globalSeed = 42): Generator<GeneratedRow> {
  const tableRows: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) {
    const rows: Record<string, unknown>[] = [];
    tableRows[table.name] = rows;
    const tableSeed = globalSeed + hashString(table.name);
    const rng = makeRng(tableSeed);
    for (let rowIndex = 0; rowIndex < table.rowCount; rowIndex++) {
      const row: Record<string, unknown> = {};
      const ctx: RowContext = { rowIndex, tableRows };
      for (const col of table.columns) {
        row[col.name] = col.gen(rng, ctx);
      }
      rows.push(row);
      yield {
        table: table.name,
        columns: table.columns.map((c) => c.name),
        values: table.columns.map((c) => row[c.name] as string | number | null)
      };
    }
  }
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export function quotedIdentFor(engine: EngineKind): (name: string) => string {
  return (name: string) => quoteIdent(engine, name);
}

export { TABLES };
