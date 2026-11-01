import {
  PostgresAdapter,
  type PostgresDriverPool,
  type PostgresDriverSession
} from '../../src/adapters/postgres/postgres-adapter.js';
import { runDatabaseAdapterContractSuite } from './database-adapter.shared.js';

function createPostgresTestHarnessPool(options: { isReadOnlyUser: boolean }): PostgresDriverPool {
  const activeTimers = new Map<number, NodeJS.Timeout>();
  let nextPid = 4100;

  return {
    async connect(): Promise<PostgresDriverSession> {
      const pid = nextPid++;
      return {
        processID: pid,
        async query(sql: string, values?: ReadonlyArray<unknown>) {
          const normalized = sql.trim();

          if (normalized.startsWith('SET SESSION CHARACTERISTICS')) {
            return { rows: [] };
          }

          if (normalized.includes('has_database_privilege')) {
            return {
              rows: [
                {
                  principal_name: options.isReadOnlyUser ? 'mcp_ro_reader' : 'app_rw_user',
                  database_name: 'erp_legacy_pg',
                  is_superuser: false,
                  can_createdb: false,
                  can_createrole: false,
                  can_create_in_db: false,
                  has_table_write_grant: !options.isReadOnlyUser
                }
              ]
            };
          }

          if (normalized.startsWith('EXPLAIN (FORMAT JSON)')) {
            if (normalized.includes('CROSS JOIN') || normalized.includes('FROM clientes, pedidos')) {
              return {
                rows: [
                  {
                    'QUERY PLAN': [
                      {
                        Plan: {
                          'Node Type': 'Nested Loop',
                          'Plan Rows': 10000,
                          'Total Cost': 850.25,
                          Plans: [
                            {
                              'Node Type': 'Seq Scan',
                              'Relation Name': 'clientes',
                              'Plan Rows': 100,
                              'Total Cost': 5.0
                            },
                            {
                              'Node Type': 'Seq Scan',
                              'Relation Name': 'pedidos',
                              'Plan Rows': 100,
                              'Total Cost': 5.0
                            }
                          ]
                        }
                      }
                    ]
                  }
                ]
              };
            }

            if (normalized.includes('WHERE id =')) {
              return {
                rows: [
                  {
                    'QUERY PLAN': [
                      {
                        Plan: {
                          'Node Type': 'Index Scan',
                          'Relation Name': 'clientes',
                          'Index Cond': '(id = $1)',
                          'Plan Rows': 1,
                          'Total Cost': 1.05
                        }
                      }
                    ]
                  }
                ]
              };
            }

            return {
              rows: [
                {
                  'QUERY PLAN': [
                    {
                      Plan: {
                        'Node Type': 'Seq Scan',
                        'Relation Name': 'clientes',
                        'Plan Rows': 250,
                        'Total Cost': 18.4
                      }
                    }
                  ]
                }
              ]
            };
          }

          if (normalized.includes('SELECT current_database()')) {
            return { rows: [{ database_name: 'erp_legacy_pg' }] };
          }

          if (normalized.includes('FROM information_schema.tables')) {
            return {
              rows: [
                {
                  schema_name: 'public',
                  table_name: 'clientes',
                  table_kind: 'TABLE',
                  column_name: 'id',
                  data_type: 'integer',
                  is_nullable: false,
                  ordinal_position: 1,
                  is_primary_key: true
                },
                {
                  schema_name: 'public',
                  table_name: 'clientes',
                  table_kind: 'TABLE',
                  column_name: 'estado',
                  data_type: 'character varying',
                  is_nullable: false,
                  ordinal_position: 2,
                  is_primary_key: false
                },
                {
                  schema_name: 'public',
                  table_name: 'pedidos',
                  table_kind: 'TABLE',
                  column_name: 'id',
                  data_type: 'integer',
                  is_nullable: false,
                  ordinal_position: 1,
                  is_primary_key: true
                },
                {
                  schema_name: 'public',
                  table_name: 'pedidos',
                  table_kind: 'TABLE',
                  column_name: 'cliente_id',
                  data_type: 'integer',
                  is_nullable: false,
                  ordinal_position: 2,
                  is_primary_key: false
                }
              ]
            };
          }

          if (normalized.includes("con.contype = 'f'")) {
            return {
              rows: [
                {
                  constraint_name: 'fk_pedidos_clientes',
                  source_schema: 'public',
                  source_table: 'pedidos',
                  source_column: 'cliente_id',
                  target_schema: 'public',
                  target_table: 'clientes',
                  target_column: 'id'
                }
              ]
            };
          }

          if (normalized.includes('FROM vista_lenta')) {
            return await new Promise((resolve) => {
              const timer = setTimeout(() => {
                activeTimers.delete(pid);
                resolve({ rows: [{ id: 1 }], fields: [{ name: 'id', dataTypeID: 23 }] });
              }, 5000);
              activeTimers.set(pid, timer);
            });
          }

          return {
            rows: [
              {
                id: 1,
                estado: values?.[0] ?? 'ACTIVO',
                saldo: values?.[1] ?? 250
              }
            ],
            fields: [
              { name: 'id', dataTypeID: 23 },
              { name: 'estado', dataTypeID: 1043 },
              { name: 'saldo', dataTypeID: 1700 }
            ]
          };
        },
        release() {
          const timer = activeTimers.get(pid);
          if (timer) {
            clearTimeout(timer);
            activeTimers.delete(pid);
          }
        }
      };
    },
    async cancelBackend(processID: number): Promise<void> {
      const timer = activeTimers.get(processID);
      if (timer) {
        clearTimeout(timer);
        activeTimers.delete(processID);
      }
    },
    async end(): Promise<void> {
      for (const timer of activeTimers.values()) {
        clearTimeout(timer);
      }
      activeTimers.clear();
    }
  };
}

runDatabaseAdapterContractSuite('PostgresAdapter (PostgreSQL)', {
  async createReadOnlyAdapter() {
    return new PostgresAdapter(
      'postgres-readonly',
      createPostgresTestHarnessPool({ isReadOnlyUser: true })
    );
  },
  async createWritableUserAdapter() {
    return new PostgresAdapter(
      'postgres-writable',
      createPostgresTestHarnessPool({ isReadOnlyUser: false })
    );
  },
  fullScanQuerySql: 'SELECT id, estado FROM clientes',
  indexedLookupQuerySql: 'SELECT id, estado FROM clientes WHERE id = $1',
  unconditionalJoinQuerySql: 'SELECT c.id FROM clientes c CROSS JOIN pedidos p',
  parameterizedSelectSql: 'SELECT id, estado, saldo FROM cuentas WHERE estado = $1 AND saldo >= $2',
  longRunningSelectSql: 'SELECT id FROM vista_lenta'
});
