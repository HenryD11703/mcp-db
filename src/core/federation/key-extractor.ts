import type {
  FederatedKeyExtractionResult,
  FederatedOverflowAction
} from '../../contracts/federated-query.contract.js';
import { FederatedKeyLimitExceededError, FederatedQueryError } from '../errors.js';

export interface KeyExtractorOptions {
  keyColumn: string;
  maxKeys?: number;
  overflowAction?: FederatedOverflowAction;
  federationId?: string;
}

export const DEFAULT_MAX_FEDERATED_KEYS = 500;
export const MAX_ALLOWED_FEDERATED_KEYS = 1000;

/**
 * Key Extractor for Federated Queries (FR-012 to FR-016, Principle III).
 * Extracts single-column keys from source rows, filters nulls, deduplicates,
 * treats extracted values as untrusted data, and enforces strict key limits.
 */
export class KeyExtractor {
  public static extractKeys(
    rows: ReadonlyArray<Record<string, unknown>>,
    options: KeyExtractorOptions
  ): FederatedKeyExtractionResult {
    const { keyColumn, federationId } = options;
    const maxKeys = Math.min(
      Math.max(options.maxKeys ?? DEFAULT_MAX_FEDERATED_KEYS, 1),
      MAX_ALLOWED_FEDERATED_KEYS
    );
    const overflowAction = options.overflowAction ?? 'truncate';

    if (!keyColumn || typeof keyColumn !== 'string') {
      throw new FederatedQueryError('A valid key column name must be provided', federationId, 'EXTRACTING_KEYS');
    }

    let nullCount = 0;
    const seen = new Set<string | number>();
    const uniqueKeys: Array<string | number> = [];

    for (const row of rows) {
      if (!(keyColumn in row)) {
        throw new FederatedQueryError(
          `Key column "${keyColumn}" was not found in source query result rows.`,
          federationId,
          'EXTRACTING_KEYS'
        );
      }

      const val = row[keyColumn];
      if (val === null || val === undefined) {
        nullCount++;
        continue;
      }

      if (typeof val !== 'string' && typeof val !== 'number') {
        const strVal = String(val);
        if (!seen.has(strVal)) {
          seen.add(strVal);
          uniqueKeys.push(strVal);
        }
      } else {
        if (!seen.has(val)) {
          seen.add(val);
          uniqueKeys.push(val);
        }
      }
    }

    const totalAvailableKeys = uniqueKeys.length;
    const isOverLimit = totalAvailableKeys > maxKeys;

    if (isOverLimit && overflowAction === 'fail') {
      throw new FederatedKeyLimitExceededError(totalAvailableKeys, maxKeys, federationId);
    }

    const finalKeys = isOverLimit ? uniqueKeys.slice(0, maxKeys) : uniqueKeys;

    return {
      keyColumn,
      rawCount: rows.length,
      uniqueKeys: finalKeys,
      nullCount,
      isTruncated: isOverLimit,
      totalAvailableKeys
    };
  }
}
