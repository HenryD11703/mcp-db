import type {
  FederatedColumnDefinition,
  FederatedJoinType
} from '../../contracts/federated-query.contract.js';
import type { ColumnDescriptor } from '../../contracts/database-adapter.js';

export interface InMemoryJoinOptions {
  sourceRows: ReadonlyArray<Record<string, unknown>>;
  sourceKeyColumn: string;
  sourceColumns?: ReadonlyArray<ColumnDescriptor>;
  targetRows: ReadonlyArray<Record<string, unknown>>;
  targetJoinColumn: string;
  targetColumns?: ReadonlyArray<ColumnDescriptor>;
  joinType?: FederatedJoinType;
}

export interface InMemoryJoinResult {
  rows: ReadonlyArray<Record<string, unknown>>;
  columns: ReadonlyArray<FederatedColumnDefinition>;
  totalMergedRows: number;
}

/**
 * In-Memory Hash Join Engine for Federated Queries (FR-004, FR-006, Principle IV).
 * Performs O(N + M) hash joins between source and target datasets in the MCP process memory.
 * Preserves query aliases, and automatically resolves identical column collisions by prefixing
 * conflicting target columns with `target_<column_name>`.
 */
export class InMemoryHashJoin {
  public static execute(options: InMemoryJoinOptions): InMemoryJoinResult {
    const {
      sourceRows,
      sourceKeyColumn,
      sourceColumns = [],
      targetRows,
      targetJoinColumn,
      targetColumns = [],
      joinType = 'LEFT'
    } = options;

    // Detect all source column names
    const sourceColSet = new Set<string>();
    for (const col of sourceColumns) {
      sourceColSet.add(col.name);
    }
    if (sourceRows.length > 0) {
      for (const k of Object.keys(sourceRows[0]!)) {
        sourceColSet.add(k);
      }
    }

    // Determine target column renamings for colliding names
    const targetColSet = new Set<string>();
    for (const col of targetColumns) {
      targetColSet.add(col.name);
    }
    if (targetRows.length > 0) {
      for (const k of Object.keys(targetRows[0]!)) {
        targetColSet.add(k);
      }
    }

    const targetKeyMapping = new Map<string, string>();
    for (const targetCol of targetColSet) {
      if (sourceColSet.has(targetCol)) {
        targetKeyMapping.set(targetCol, `target_${targetCol}`);
      } else {
        targetKeyMapping.set(targetCol, targetCol);
      }
    }

    // Index target rows by targetJoinColumn
    const targetIndex = new Map<string, Array<Record<string, unknown>>>();
    for (const targetRow of targetRows) {
      const rawJoinVal = targetRow[targetJoinColumn];
      if (rawJoinVal === null || rawJoinVal === undefined) {
        continue;
      }
      const keyStr = String(rawJoinVal);
      const existing = targetIndex.get(keyStr);
      if (existing) {
        existing.push(targetRow);
      } else {
        targetIndex.set(keyStr, [targetRow]);
      }
    }

    // Build unified column definitions
    const unifiedColumns: FederatedColumnDefinition[] = [];
    const recordedColNames = new Set<string>();

    for (const colName of sourceColSet) {
      const meta = sourceColumns.find((c) => c.name === colName);
      unifiedColumns.push({
        name: colName,
        type: meta?.dataType ?? 'unknown',
        sourceOrigin: 'source',
        isMaskedOrPseudonymized: false
      });
      recordedColNames.add(colName);
    }

    for (const targetCol of targetColSet) {
      const mappedName = targetKeyMapping.get(targetCol) ?? targetCol;
      const meta = targetColumns.find((c) => c.name === targetCol);
      if (!recordedColNames.has(mappedName)) {
        unifiedColumns.push({
          name: mappedName,
          type: meta?.dataType ?? 'unknown',
          sourceOrigin: 'target',
          isMaskedOrPseudonymized: false
        });
        recordedColNames.add(mappedName);
      }
    }

    // Map target row keys
    const mapTargetRow = (row: Record<string, unknown>): Record<string, unknown> => {
      const mapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        const targetName = targetKeyMapping.get(k) ?? k;
        mapped[targetName] = v;
      }
      return mapped;
    };

    // Create empty target row structure for unmatched LEFT join rows
    const emptyTargetRow: Record<string, unknown> = {};
    for (const targetCol of targetColSet) {
      const mappedName = targetKeyMapping.get(targetCol) ?? targetCol;
      emptyTargetRow[mappedName] = null;
    }

    // Execute hash join
    const mergedRows: Array<Record<string, unknown>> = [];

    for (const sourceRow of sourceRows) {
      const rawKey = sourceRow[sourceKeyColumn];
      const keyStr = rawKey !== null && rawKey !== undefined ? String(rawKey) : null;
      const matchingTargetRows = keyStr !== null ? targetIndex.get(keyStr) : undefined;

      if (matchingTargetRows && matchingTargetRows.length > 0) {
        for (const tRow of matchingTargetRows) {
          mergedRows.push({
            ...sourceRow,
            ...mapTargetRow(tRow)
          });
        }
      } else if (joinType === 'LEFT') {
        mergedRows.push({
          ...sourceRow,
          ...emptyTargetRow
        });
      }
    }

    return {
      rows: mergedRows,
      columns: unifiedColumns,
      totalMergedRows: mergedRows.length
    };
  }
}
