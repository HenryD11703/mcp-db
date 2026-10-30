import type { SchemaCatalog, TableMetadata } from '../../src/contracts/database-adapter.js';
import type { CatalogExtras, CatalogSnapshot } from '../../src/contracts/legacy-discovery.contract.js';

export type ColSpec = readonly [name: string, type: string];

export function table(
  name: string,
  cols: ReadonlyArray<ColSpec>,
  pk: ReadonlyArray<string> = [],
  schema = 'dbo',
  kind: 'TABLE' | 'VIEW' = 'TABLE'
): TableMetadata {
  return {
    schema,
    name,
    kind,
    primaryKeyColumns: pk,
    columns: cols.map(([n, t], i) => ({
      name: n,
      dataType: t,
      isNullable: !pk.includes(n),
      ordinalPosition: i + 1
    }))
  };
}

export function catalogOf(
  tables: ReadonlyArray<TableMetadata>,
  foreignKeys: SchemaCatalog['foreignKeys'] = []
): SchemaCatalog {
  return {
    databaseName: 'legacy',
    dialect: 'tsql',
    tables,
    foreignKeys,
    inspectedAt: new Date(0).toISOString()
  };
}

export function snapshotOf(
  tables: ReadonlyArray<TableMetadata>,
  extras: CatalogExtras | null = null,
  foreignKeys: SchemaCatalog['foreignKeys'] = []
): CatalogSnapshot {
  return { catalog: catalogOf(tables, foreignKeys), extras };
}

/** Legacy schema without any declared foreign key. */
export const LEGACY_TABLES: ReadonlyArray<TableMetadata> = [
  table('clientes', [['id', 'int'], ['nombre', 'varchar']], ['id']),
  table(
    'pedidos',
    [
      ['id', 'int'],
      ['id_cliente', 'int'],
      ['status', 'varchar'],
      ['fecha', 'date'],
      ['cod_vendedor', 'int']
    ],
    ['id']
  ),
  table('vendedores', [['cod_vendedor', 'int'], ['nombre', 'varchar']], ['cod_vendedor']),
  table('mae_clientes', [['cod_cli', 'varchar'], ['nom', 'varchar']], ['cod_cli']),
  table(
    'fac_encabezado',
    [
      ['num_fac', 'int'],
      ['cod_cli', 'varchar'],
      ['fecha_pago', 'date']
    ],
    ['num_fac']
  ),
  table('fac_detalle', [['num_fac', 'int'], ['linea', 'int'], ['cod_art', 'int']]),
  table('articulos', [['cod_art', 'int'], ['descripcion', 'varchar']], ['cod_art']),
  table('productos', [['id', 'int'], ['status', 'varchar']], ['id']),
  table('calendario', [['codigo', 'varchar']], ['codigo']),
  table('usuarios', [['id', 'int'], ['login', 'varchar']], ['id']),
  table('log_acceso', [['id', 'int'], ['usr_id', 'int']], ['id']),
  table('cliente_historial', [['id', 'int'], ['id_cliente', 'int']], ['id'])
];

/** Ground truth (child -> parent) for the legacy schema above. */
export const LEGACY_EXPECTED: ReadonlyArray<string> = [
  'pedidos.id_cliente->clientes.id',
  'pedidos.cod_vendedor->vendedores.cod_vendedor',
  'fac_encabezado.cod_cli->mae_clientes.cod_cli',
  'fac_detalle.cod_art->articulos.cod_art',
  'fac_detalle.num_fac->fac_encabezado.num_fac',
  'log_acceso.usr_id->usuarios.id',
  'cliente_historial.id_cliente->clientes.id'
];

export function relationKey(r: {
  child: { table: string; column: string };
  parent: { table: string; column: string };
}): string {
  return `${r.child.table}.${r.child.column}->${r.parent.table}.${r.parent.column}`;
}
