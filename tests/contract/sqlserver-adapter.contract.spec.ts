import {
  SqlServerAdapter,
  type SqlServerDriverPool,
  type SqlServerDriverRequest
} from '../../src/adapters/sqlserver/sqlserver-adapter.js';
import type { QueryParameter } from '../../src/contracts/database-adapter.js';
import { runDatabaseAdapterContractSuite } from './database-adapter.shared.js';

function createSqlServerTestHarnessPool(options: { isReadOnlyUser: boolean }): SqlServerDriverPool {
  const activeTimers = new Set<NodeJS.Timeout>();

  return {
    createRequest(): SqlServerDriverRequest {
      const boundParams = new Map<string, unknown>();
      let currentTimer: NodeJS.Timeout | undefined;

      return {
        input(name: string, _type: QueryParameter['type'], value: unknown) {
          boundParams.set(name, value);
        },
        async query(command: string) {
          const normalized = command.trim();

          if (normalized.includes("IS_SRVROLEMEMBER('sysadmin')")) {
            return {
              recordset: [
                {
                  principal_name: options.isReadOnlyUser ? 'mcp_tsql_ro' : 'dbo_writer',
                  database_name: 'CoreFinanzasDB',
                  is_sysadmin: 0,
                  is_db_owner: 0,
                  is_db_datawriter: options.isReadOnlyUser ? 0 : 1,
                  is_db_ddladmin: 0,
                  write_permission_count: options.isReadOnlyUser ? 0 : 2
                }
              ]
            };
          }

          if (normalized.includes('SELECT DB_NAME()')) {
            return { recordset: [{ database_name: 'CoreFinanzasDB' }] };
          }

          if (normalized.includes('FROM sys.objects o')) {
            return {
              recordset: [
                {
                  schema_name: 'dbo',
                  table_name: 'clientes',
                  table_kind: 'TABLE',
                  column_name: 'id',
                  data_type: 'int',
                  is_nullable: false,
                  ordinal_position: 1,
                  is_primary_key: true
                },
                {
                  schema_name: 'dbo',
                  table_name: 'clientes',
                  table_kind: 'TABLE',
                  column_name: 'estado',
                  data_type: 'nvarchar',
                  is_nullable: false,
                  ordinal_position: 2,
                  is_primary_key: false
                },
                {
                  schema_name: 'dbo',
                  table_name: 'pedidos',
                  table_kind: 'TABLE',
                  column_name: 'id',
                  data_type: 'int',
                  is_nullable: false,
                  ordinal_position: 1,
                  is_primary_key: true
                },
                {
                  schema_name: 'dbo',
                  table_name: 'pedidos',
                  table_kind: 'TABLE',
                  column_name: 'cliente_id',
                  data_type: 'int',
                  is_nullable: false,
                  ordinal_position: 2,
                  is_primary_key: false
                }
              ]
            };
          }

          if (normalized.includes('FROM sys.foreign_keys fk')) {
            return {
              recordset: [
                {
                  constraint_name: 'FK_pedidos_clientes',
                  source_schema: 'dbo',
                  source_table: 'pedidos',
                  source_column: 'cliente_id',
                  target_schema: 'dbo',
                  target_table: 'clientes',
                  target_column: 'id'
                }
              ]
            };
          }

          if (normalized.includes('FROM dbo.vista_lenta')) {
            return await new Promise((resolve) => {
              currentTimer = setTimeout(() => {
                if (currentTimer) activeTimers.delete(currentTimer);
                resolve({ recordset: [{ id: 1 }] });
              }, 5000);
              activeTimers.add(currentTimer);
            });
          }

          return {
            recordset: [
              {
                id: 1,
                estado: boundParams.get('estado') ?? 'ACTIVO',
                saldo: boundParams.get('minSaldo') ?? 250
              }
            ]
          };
        },
        cancel() {
          if (currentTimer) {
            clearTimeout(currentTimer);
            activeTimers.delete(currentTimer);
          }
        }
      };
    },
    async explainXml(sqlText: string): Promise<string> {
      if (sqlText.includes('CROSS JOIN')) {
        return `
          <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
            <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="15000" EstimatedTotalSubtreeCost="72.4" NoJoinPredicate="1">
              <RelOp NodeId="1" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="150" EstimatedTotalSubtreeCost="1.1" />
              <RelOp NodeId="2" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="100" EstimatedTotalSubtreeCost="0.9" />
            </RelOp>
          </ShowPlanXML>
        `;
      }

      if (sqlText.includes('WHERE id =')) {
        return `
          <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
            <RelOp NodeId="0" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="1" EstimatedTotalSubtreeCost="0.0032831" />
          </ShowPlanXML>
        `;
      }

      return `
        <ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
          <RelOp NodeId="0" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="400" EstimatedTotalSubtreeCost="3.45" />
        </ShowPlanXML>
      `;
    },
    async close(): Promise<void> {
      for (const t of activeTimers) {
        clearTimeout(t);
      }
      activeTimers.clear();
    }
  };
}

runDatabaseAdapterContractSuite('SqlServerAdapter (T-SQL)', {
  async createReadOnlyAdapter() {
    return new SqlServerAdapter(
      'sqlserver-readonly',
      createSqlServerTestHarnessPool({ isReadOnlyUser: true })
    );
  },
  async createWritableUserAdapter() {
    return new SqlServerAdapter(
      'sqlserver-writable',
      createSqlServerTestHarnessPool({ isReadOnlyUser: false })
    );
  },
  fullScanQuerySql: 'SELECT id, estado FROM dbo.clientes',
  indexedLookupQuerySql: 'SELECT id, estado FROM dbo.clientes WHERE id = @id',
  unconditionalJoinQuerySql: 'SELECT c.id FROM dbo.clientes c CROSS JOIN dbo.pedidos p',
  parameterizedSelectSql:
    'SELECT id, estado, saldo FROM dbo.cuentas WHERE estado = @estado AND saldo >= @minSaldo',
  longRunningSelectSql: 'SELECT id FROM dbo.vista_lenta'
});
