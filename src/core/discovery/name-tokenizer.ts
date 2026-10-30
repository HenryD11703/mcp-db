const ID_TOKENS = new Set(['id', 'cod', 'codigo', 'cd', 'fk', 'key', 'num', 'nro', 'no', 'ref', 'idx']);
const TABLE_NOISE_TOKENS = new Set(['tbl', 'tb', 't', 'mae', 'mst', 'mstr', 'maestro', 'dim', 'cat', 'tab', 'vw', 'v']);
export const GENERIC_COLUMN_TOKENS = new Set([
  'id',
  'cod',
  'codigo',
  'status',
  'estado',
  'est',
  'fecha',
  'fec',
  'tipo',
  'tip',
  'descripcion',
  'desc',
  'nombre',
  'name',
  'type',
  'date',
  'flag',
  'obs',
  'observaciones',
  'valor',
  'monto',
  'total'
]);

export const DEFAULT_ABBREVIATIONS: Readonly<Record<string, string>> = {
  cli: 'cliente',
  clie: 'cliente',
  usr: 'usuario',
  usu: 'usuario',
  art: 'articulo',
  prod: 'producto',
  prd: 'producto',
  fac: 'factura',
  fact: 'factura',
  ped: 'pedido',
  emp: 'empleado',
  prv: 'proveedor',
  prov: 'proveedor',
  cta: 'cuenta',
  ord: 'orden',
  cat: 'categoria',
  suc: 'sucursal',
  alm: 'almacen',
  dep: 'departamento',
  det: 'detalle',
  enc: 'encabezado',
  cust: 'customer',
  cus: 'customer',
  usrs: 'usuario'
};

export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Splits identifiers by `_`, `-`, spaces, camelCase and letter/digit boundaries. */
export function tokenize(name: string): string[] {
  const spaced = stripAccents(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function singularize(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && token.endsWith('es') && /(s|x|z|ch|sh|n|l|r)es$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

export function isIdToken(token: string): boolean {
  return ID_TOKENS.has(token);
}

export function isGenericColumn(name: string): boolean {
  const tokens = tokenize(name);
  return tokens.length > 0 && tokens.every((t) => GENERIC_COLUMN_TOKENS.has(t) || isIdToken(t));
}

export function normalizeName(name: string): string {
  return tokenize(name).join('_');
}

export interface TokenizerOptions {
  readonly abbreviations?: Readonly<Record<string, string>>;
}

/** Entity tokens of a column name: the part that is neither an id marker nor a number. */
export function entityTokensOfColumn(name: string, options: TokenizerOptions = {}): string[] {
  const abbreviations = { ...DEFAULT_ABBREVIATIONS, ...(options.abbreviations ?? {}) };
  return tokenize(name)
    .filter((t) => !isIdToken(t) && !/^\d+$/.test(t))
    .map((t) => singularize(abbreviations[t] ?? abbreviations[singularize(t)] ?? t));
}

/** Entity tokens of a table name (noise prefixes such as `tbl_`/`mae_` removed). */
export function entityTokensOfTable(name: string): string[] {
  const tokens = tokenize(name).filter((t) => !TABLE_NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
  return tokens.map((t) => singularize(t));
}

/**
 * Strength (0..1) with which the column's entity tokens refer to the table's entity tokens:
 *  1.0 exact, 0.85 abbreviation prefix (`cli` ~ `cliente`), 0 otherwise.
 */
export function entityMatchStrength(
  columnEntity: ReadonlyArray<string>,
  tableEntity: ReadonlyArray<string>
): number {
  if (columnEntity.length === 0 || tableEntity.length === 0) {
    return 0;
  }
  const colJoined = columnEntity.join('');
  const tableJoined = tableEntity.join('');
  if (colJoined === tableJoined) {
    return 1;
  }
  // Abbreviation prefix (`cli` ~ `cliente`) is only trusted for single-word tables,
  // so `id_cliente` never points at `cliente_historial`.
  if (tableEntity.length === 1 && colJoined.length >= 3 && tableJoined.startsWith(colJoined)) {
    return 0.85;
  }
  return 0;
}
