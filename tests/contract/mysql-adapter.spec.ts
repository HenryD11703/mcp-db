import { describe, expect, it } from 'vitest';
import {
  MySqlAdapter,
  type MySqlDriverPool,
  type MySqlDriverConnection
} from '../../src/adapters/mysql/mysql-adapter.js';
import { runDatabaseAdapterContractSuite } from './database-adapter.shared.js';

export function createMySqlTestHarnessPool(options: { isReadOnlyUser: boolean }): MySqlDriverPool {
  let nextThreadId = 5000;
  const activeTimers = new Map<number, NodeJS.Timeout>();

  return {
    async getConnection(): Promise<MySqlDriverConnection> {
      const threadId = nextThreadId++;

      return {
        threadId,
        async query(sql: string, values?: ReadonlyArray<unknown>): Promise<[any, any]> {
          const normalized = sql.trim();

          if (normalized.toUpperCase().startsWith('SET SESSION SQL_MODE')) {
            return [[], []];
          }

          if (normalized.includes('information_schema.user_privileges')) {
            return [
              [
                {
                  principal_name: options.isReadOnlyUser ? 'mcp_ro@%' : 'app_rw@%',
                  database_name: 'test_db',
                  has_global_write: options.isReadOnlyUser ? 0 : 1,
                  has_schema_write: 0,
                  has_table_write: options.isReadOnlyUser ? 0 : 1
                }
              ],
              []
            ];
          }

          if (normalized.toUpperCase().startsWith('EXPLAIN FORMAT=JSON')) {
            if (normalized.includes('CROSS JOIN') || normalized.includes('FROM clientes, pedidos')) {
              return [
                [
                  {
                    EXPLAIN: JSON.stringify({
                      query_block: {
                        cost_info: { query_cost: '850.25' },
                        nested_loop: [
                          {
                            table: {
                              table_name: 'clientes',
                              access_type: 'ALL',
                              rows_examined_per_scan: 100,
                              cost_info: { eval_cost: '5.0' }
                            }
                          },
                          {
                            table: {
                              table_name: 'pedidos',
                              access_type: 'ALL',
                              rows_examined_per_scan: 100,
                              cost_info: { eval_cost: '5.0' }
                            }
                          }
                        ]
                      }
                    })
                  }
                ],
                []
              ];
            }

            if (normalized.includes('WHERE id =')) {
              return [
                [
                  {
                    EXPLAIN: JSON.stringify({
                      query_block: {
                        cost_info: { query_cost: '1.05' },
                        table: {
                          table_name: 'clientes',
                          access_type: 'const',
                          rows_examined_per_scan: 1,
                          cost_info: { eval_cost: '0.1' }
                        }
                      }
                    })
                  }
                ],
                []
              ];
            }

            return [
              [
                {
                  EXPLAIN: JSON.stringify({
                    query_block: {
                      cost_info: { query_cost: '20.0' },
                      table: {
                        table_name: 'clientes',
                        access_type: 'ALL',
                        rows_examined_per_scan: 100,
                        cost_info: { eval_cost: '10.0' }
                      }
                    }
                  })
                }
              ],
              []
            ];
          }

          if (normalized.includes('vista_lenta') || normalized.includes('long_running')) {
            return new Promise((resolve) => {
              const timer = setTimeout(() => {
                activeTimers.delete(threadId);
                resolve([[{ id: 1 }], [{ name: 'id', type: 3 }]]);
              }, 5000);
              activeTimers.set(threadId, timer);
            });
          }

          if (normalized.includes('FROM information_schema.tables')) {
            return [
              [
                {
                  schema_name: 'test_db',
                  table_name: 'clientes',
                  table_kind: 'TABLE',
                  column_name: 'id',
                  data_type: 'int',
                  is_nullable: false,
                  ordinal_position: 1,
                  is_primary_key: 1
                },
                {
                  schema_name: 'test_db',
                  table_name: 'clientes',
                  table_kind: 'TABLE',
                  column_name: 'nombre',
                  data_type: 'varchar',
                  is_nullable: true,
                  ordinal_position: 2,
                  is_primary_key: 0
                },
                {
                  schema_name: 'test_db',
                  table_name: 'pedidos',
                  table_kind: 'TABLE',
                  column_name: 'id',
                  data_type: 'int',
                  is_nullable: false,
                  ordinal_position: 1,
                  is_primary_key: 1
                },
                {
                  schema_name: 'test_db',
                  table_name: 'pedidos',
                  table_kind: 'TABLE',
                  column_name: 'cliente_id',
                  data_type: 'int',
                  is_nullable: false,
                  ordinal_position: 2,
                  is_primary_key: 0
                }
              ],
              []
            ];
          }

          if (normalized.includes('FROM information_schema.key_column_usage')) {
            return [
              [
                {
                  constraint_name: 'fk_pedidos_clientes',
                  source_table: 'pedidos',
                  source_column: 'cliente_id',
                  target_table: 'clientes',
                  target_column: 'id'
                }
              ],
              []
            ];
          }

          return [[{ id: 1, nombre: 'Ana' }], [{ name: 'id', type: 3 }, { name: 'nombre', type: 253 }]];
        },
        release() {
          const timer = activeTimers.get(threadId);
          if (timer) {
            clearTimeout(timer);
            activeTimers.delete(threadId);
          }
        }
      };
    },
    async execute(sql: string, values?: ReadonlyArray<unknown>): Promise<[any, any]> {
      const match = sql.match(/KILL QUERY\s+(\d+)/i);
      if (match) {
        const tid = parseInt(match[1]!, 10);
        const timer = activeTimers.get(tid);
        if (timer) {
          clearTimeout(timer);
          activeTimers.delete(tid);
        }
      }
      return [[], []];
    },
    async end(): Promise<void> {
      for (const [, timer] of activeTimers) {
        clearTimeout(timer);
      }
      activeTimers.clear();
    }
  };
}

runDatabaseAdapterContractSuite('MySqlAdapter', {
  createReadOnlyAdapter: async () => {
    const pool = createMySqlTestHarnessPool({ isReadOnlyUser: true });
    return new MySqlAdapter({
      adapterId: 'mysql-test-ro',
      dialect: 'mysql',
      pool
    });
  },
  createWritableUserAdapter: async () => {
    const pool = createMySqlTestHarnessPool({ isReadOnlyUser: false });
    return new MySqlAdapter({
      adapterId: 'mysql-test-rw',
      dialect: 'mysql',
      pool
    });
  },
  fullScanQuerySql: 'SELECT id FROM clientes',
  indexedLookupQuerySql: 'SELECT id FROM clientes WHERE id = 1',
  unconditionalJoinQuerySql: 'SELECT clientes.id FROM clientes, pedidos',
  parameterizedSelectSql: 'SELECT id, nombre FROM clientes WHERE id = ?',
  longRunningSelectSql: 'SELECT id FROM vista_lenta'
});
