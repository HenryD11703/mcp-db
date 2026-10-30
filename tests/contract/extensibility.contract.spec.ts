import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  DatabaseAdapter,
  NormalizedRiskProfile,
  ParameterizedQuery,
  QueryExecutionResult,
  ReadOnlyVerificationResult,
  SchemaCatalog
} from '../../src/contracts/database-adapter.js';
import { AdapterRegistry } from '../../src/core/engine-registry.js';
import {
  QueryCancelledError,
  ReadOnlyPrivilegeError,
  SqlSecurityRejectionError
} from '../../src/core/errors.js';
import { runDatabaseAdapterContractSuite } from './database-adapter.shared.js';

/**
 * Synthetic 3rd relational engine adapter implemented by a contributor without touching `src/core/` (`SC-005`).
 */
class SyntheticThirdEngineAdapter implements DatabaseAdapter {
  public readonly dialect = 'postgres' as const;
  public readonly adapterId: string;
  private readonly isReadOnlyAccount: boolean;

  constructor(adapterId: string, isReadOnlyAccount: boolean) {
    this.adapterId = adapterId;
    this.isReadOnlyAccount = isReadOnlyAccount;
  }

  public async verifyReadOnly(): Promise<ReadOnlyVerificationResult> {
    return {
      isReadOnly: this.isReadOnlyAccount,
      principalName: this.isReadOnlyAccount ? 'third_ro_user' : 'third_rw_admin',
      sessionReadOnlyEnforced: this.isReadOnlyAccount,
      violations: this.isReadOnlyAccount
        ? []
        : ['User holds write privileges on synthetic third engine.'],
      checkedAt: new Date().toISOString()
    };
  }

  public async analyzeQueryPlan(query: ParameterizedQuery): Promise<NormalizedRiskProfile> {
    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }
    const isCartesian = query.sql.includes('CROSS JOIN');
    const isIndexed = query.sql.includes('WHERE id =');
    return {
      hasFullScan: !isIndexed,
      hasUnconditionalJoin: isCartesian,
      estimatedRows: isCartesian ? 5000 : isIndexed ? 1 : 100,
      estimatedCost: isCartesian ? 200.5 : isIndexed ? 0.5 : 10.2
    };
  }

  public async executeQuery(query: ParameterizedQuery): Promise<QueryExecutionResult> {
    if (query.signal?.aborted) {
      throw new QueryCancelledError(this.adapterId);
    }

    if (query.sql.includes('vista_lenta')) {
      return await new Promise<QueryExecutionResult>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          resolvePromise({
            columns: [{ name: 'id', dataType: 'integer' }],
            rows: [{ id: 1 }],
            rowCount: 1,
            durationMs: 5000
          });
        }, 5000);

        query.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            rejectPromise(new QueryCancelledError(this.adapterId));
          },
          { once: true }
        );
      });
    }

    return {
      columns: [
        { name: 'id', dataType: 'integer' },
        { name: 'estado', dataType: 'varchar' }
      ],
      rows: [{ id: 1, estado: 'ACTIVO' }],
      rowCount: 1,
      durationMs: 2
    };
  }

  public async introspectSchema(): Promise<SchemaCatalog> {
    return {
      databaseName: 'third_engine_db',
      dialect: 'postgres',
      tables: [
        {
          schema: 'public',
          name: 'clientes',
          kind: 'TABLE',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, ordinalPosition: 1 },
            { name: 'estado', dataType: 'varchar', isNullable: false, ordinalPosition: 2 }
          ],
          primaryKeyColumns: ['id']
        },
        {
          schema: 'public',
          name: 'pedidos',
          kind: 'TABLE',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false, ordinalPosition: 1 },
            { name: 'cliente_id', dataType: 'integer', isNullable: false, ordinalPosition: 2 }
          ],
          primaryKeyColumns: ['id']
        }
      ],
      foreignKeys: [
        {
          constraintName: 'fk_third_pedidos_clientes',
          sourceSchema: 'public',
          sourceTable: 'pedidos',
          sourceColumn: 'cliente_id',
          targetSchema: 'public',
          targetTable: 'clientes',
          targetColumn: 'id'
        }
      ],
      inspectedAt: new Date().toISOString()
    };
  }

  public async close(): Promise<void> {}
}

function listTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      results.push(...listTypeScriptFiles(fullPath));
    } else if (fullPath.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

runDatabaseAdapterContractSuite('SyntheticThirdEngineAdapter (Contributor Extensibility)', {
  async createReadOnlyAdapter() {
    return new SyntheticThirdEngineAdapter('third-ro', true);
  },
  async createWritableUserAdapter() {
    return new SyntheticThirdEngineAdapter('third-rw', false);
  },
  fullScanQuerySql: 'SELECT id, estado FROM clientes',
  indexedLookupQuerySql: 'SELECT id, estado FROM clientes WHERE id = $1',
  unconditionalJoinQuerySql: 'SELECT c.id FROM clientes c CROSS JOIN pedidos p',
  parameterizedSelectSql: 'SELECT id, estado FROM clientes WHERE estado = $1 AND id >= $2',
  longRunningSelectSql: 'SELECT id FROM vista_lenta'
});

describe('Core Architectural Decoupling & Extensibility (FR-001, FR-002, SC-005)', () => {
  it('statically verifies that src/core/ has zero imports of concrete database drivers (pg, mssql) or src/adapters/', () => {
    const coreDir = resolve(process.cwd(), 'src/core');
    const coreFiles = listTypeScriptFiles(coreDir);
    expect(coreFiles.length).toBeGreaterThan(0);

    for (const file of coreFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content, `File ${file} must not import pg`).not.toMatch(
        /from\s+['"]pg['"]/
      );
      expect(content, `File ${file} must not import mssql`).not.toMatch(
        /from\s+['"]mssql['"]/
      );
      expect(content, `File ${file} must not import src/adapters`).not.toMatch(
        /adapters\//
      );
    }
  });

  it('registers a 3rd adapter in AdapterRegistry, enforces preflight and adversarial guard, and executes queries without modifying src/core/', async () => {
    const registry = new AdapterRegistry();
    registry.registerAdapter(new SyntheticThirdEngineAdapter('custom-engine', true));

    const preflightMap = await registry.initializeAllWithPreflight();
    expect(preflightMap.get('custom-engine')?.isReadOnly).toBe(true);

    const explain = await registry.validateAndExplain('custom-engine', {
      sql: 'SELECT id, estado FROM clientes WHERE id = $1',
      params: [{ name: 'id', type: 'number', value: 1 }]
    });
    expect(explain.hasFullScan).toBe(false);

    const execRes = await registry.validateAndExecute('custom-engine', {
      sql: 'SELECT id, estado FROM clientes WHERE id = $1',
      params: [{ name: 'id', type: 'number', value: 1 }]
    });
    expect(execRes.rowCount).toBe(1);

    await expect(
      registry.validateAndExecute('custom-engine', {
        sql: 'SELECT id FROM clientes; DROP TABLE clientes',
        params: []
      })
    ).rejects.toThrow(SqlSecurityRejectionError);

    await registry.closeAll();
  });

  it('refuses to initialize AdapterRegistry when any adapter fails read-only preflight check (FR-003)', async () => {
    const registry = new AdapterRegistry();
    registry.registerAdapter(new SyntheticThirdEngineAdapter('writable-engine', false));

    await expect(registry.initializeAllWithPreflight()).rejects.toThrow(
      ReadOnlyPrivilegeError
    );
    await registry.closeAll();
  });
});
