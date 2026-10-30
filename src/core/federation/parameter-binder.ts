import type {
  EngineDialect,
  ParameterizedQuery,
  QueryParameter,
  QueryParameterType
} from '../../contracts/database-adapter.js';
import { FederatedQueryError } from '../errors.js';

export interface ParameterBinderOptions {
  sqlTemplate: string;
  keys: ReadonlyArray<string | number>;
  dialect: EngineDialect;
  federationId?: string;
  paramPrefixOffset?: number;
  signal?: AbortSignal;
}

/**
 * Parameter Binder for Federated Queries (FR-013, Principle III).
 * Safely expands the explicit `:keys` placeholder in target SQL templates
 * into typed dialect parameter markers ($1, $2, ... for PostgreSQL or @p1, @p2, ... for SQL Server).
 * Raw key values are NEVER concatenated into the SQL string; they travel strictly via the `params` array.
 */
export class ParameterBinder {
  public static bindKeys(options: ParameterBinderOptions): ParameterizedQuery {
    const { sqlTemplate, keys, dialect, federationId, paramPrefixOffset = 0, signal } = options;

    if (!sqlTemplate || typeof sqlTemplate !== 'string') {
      throw new FederatedQueryError(
        'Target SQL template must be a non-empty string.',
        federationId,
        'PREPARING_TARGET'
      );
    }

    if (!sqlTemplate.includes(':keys')) {
      throw new FederatedQueryError(
        'Target SQL template must contain an explicit ":keys" placeholder (e.g. "WHERE column IN (:keys)").',
        federationId,
        'PREPARING_TARGET'
      );
    }

    if (keys.length === 0) {
      throw new FederatedQueryError(
        'Cannot bind empty keys list to SQL query. Zero keys must be handled via empty short-circuit.',
        federationId,
        'PREPARING_TARGET'
      );
    }

    const markers: string[] = [];
    const params: QueryParameter[] = [];

    for (let i = 0; i < keys.length; i++) {
      const idx = i + 1 + paramPrefixOffset;
      const keyVal = keys[i]!;
      const paramType: QueryParameterType = typeof keyVal === 'number' ? 'number' : 'string';

      if (dialect === 'postgres') {
        markers.push(`$${idx}`);
        params.push({
          name: `${idx}`,
          type: paramType,
          value: keyVal
        });
      } else {
        // T-SQL dialect
        markers.push(`@p${idx}`);
        params.push({
          name: `p${idx}`,
          type: paramType,
          value: keyVal
        });
      }
    }

    const markersString = markers.join(', ');
    const expandedSql = sqlTemplate.replace(/(:\bkeys\b|:keys)/g, () => markersString);

    return {
      sql: expandedSql,
      params,
      signal
    };
  }
}
