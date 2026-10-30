import type {
  OperationalLimitsPolicy,
  EngineRiskThresholds
} from '../../contracts/cost-limits.contract.js';

export const defaultOperationalLimitsPolicy: OperationalLimitsPolicy = {
  executionTimeoutMs: Number(process.env['MCP_EXECUTION_TIMEOUT_MS']) || 5000,
  maxRowsLimit: Number(process.env['MCP_MAX_ROWS_LIMIT']) || 1000,
  rateLimitPerClientPerMinute: Number(process.env['MCP_RATE_LIMIT_CLIENT_CPM']) || 60,
  rateLimitGlobalPerMinute: Number(process.env['MCP_RATE_LIMIT_GLOBAL_CPM']) || 300
};

export const defaultEngineRiskThresholds: EngineRiskThresholds = {
  largeTablesBlocklist: process.env['MCP_LARGE_TABLES_BLOCKLIST']
    ? process.env['MCP_LARGE_TABLES_BLOCKLIST']
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [],
  maxEstimatedRowsCaution: Number(process.env['MCP_MAX_ESTIMATED_ROWS_CAUTION']) || 10000,
  maxEstimatedRowsBlock: Number(process.env['MCP_MAX_ESTIMATED_ROWS_BLOCK']) || 100000,
  maxEstimatedCostCaution: Number(process.env['MCP_MAX_ESTIMATED_COST_CAUTION']) || 5000,
  maxEstimatedCostBlock: Number(process.env['MCP_MAX_ESTIMATED_COST_BLOCK']) || 50000,
  prohibitCartesianJoins: process.env['MCP_PROHIBIT_CARTESIAN_JOINS'] !== 'false',
  planTimeoutMs: Number(process.env['MCP_PLAN_TIMEOUT_MS']) || 2000
};
