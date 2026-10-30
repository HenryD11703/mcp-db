import type { ReadOnlyVerificationResult } from '../../contracts/database-adapter.js';
import type {
  IStartupPreflightGate,
  PreflightAdapterReport,
  ServerPreflightSummary
} from '../../contracts/security.contract.js';
import type { AdapterRegistry } from '../engine-registry.js';
import { PreflightFatalError, ReadOnlyPrivilegeError } from '../errors.js';

export interface StartupPreflightGateOptions {
  /**
   * Whether to invoke `exitHandler(1)` when write privileges are detected.
   * Defaults to `false` in programmatic library mode unless explicitly enabled for server CLI startup.
   */
  readonly exitOnFailure?: boolean;
  /**
   * Custom process exit callback (defaults to `(code) => process.exit(code)`).
   */
  readonly exitHandler?: (exitCode: number) => void;
  /**
   * Structured info logger (defaults to `console.info`).
   */
  readonly logger?: (message: string) => void;
  /**
   * Structured error logger (defaults to `console.error`).
   */
  readonly errorLogger?: (message: string) => void;
}

/**
 * Enforces mandatory read-only preflight verification at server startup (`FR-010` to `FR-014`).
 * Refuses to start the MCP server if any registered database connection holds write privileges.
 */
export class StartupPreflightGate implements IStartupPreflightGate {
  private readonly registry: AdapterRegistry;
  private readonly exitOnFailure: boolean;
  private readonly exitHandler: (exitCode: number) => void;
  private readonly logger: (message: string) => void;
  private readonly errorLogger: (message: string) => void;
  private lastSummary: ServerPreflightSummary | null = null;

  constructor(registry: AdapterRegistry, options: StartupPreflightGateOptions = {}) {
    this.registry = registry;
    this.exitOnFailure = options.exitOnFailure ?? false;
    this.exitHandler = options.exitHandler ?? ((code: number) => process.exit(code));
    this.logger = options.logger ?? (() => {});
    this.errorLogger = options.errorLogger ?? ((msg: string) => console.error(msg));
  }

  public getLastSummary(): ServerPreflightSummary | null {
    return this.lastSummary;
  }

  public async verifyAndEnforceStartup(
    signal?: AbortSignal
  ): Promise<ReadonlyMap<string, ReadOnlyVerificationResult>> {
    const adapterIds = this.registry.listAdapterIds();
    const reports: PreflightAdapterReport[] = [];

    try {
      const results = await this.registry.initializeAllWithPreflight(signal);
      for (const id of adapterIds) {
        const adapter = this.registry.getAdapter(id);
        const res = results.get(id)!;
        const report: PreflightAdapterReport = {
          adapterId: id,
          dialect: adapter.dialect,
          principalName: res.principalName,
          isReadOnly: res.isReadOnly,
          violations: res.violations,
          checkedAt: res.checkedAt
        };
        reports.push(report);
        this.logger(
          JSON.stringify({
            event: 'PREFLIGHT_PASSED',
            adapterId: id,
            dialect: adapter.dialect,
            principalName: res.principalName,
            checkedAt: res.checkedAt
          })
        );
      }

      this.lastSummary = {
        allPassed: true,
        totalAdapters: adapterIds.length,
        reports,
        abortedProcess: false
      };

      return results;
    } catch (err) {
      if (err instanceof ReadOnlyPrivilegeError) {
        const adapter = this.registry.getAdapter(err.adapterId);
        const failedReport: PreflightAdapterReport = {
          adapterId: err.adapterId,
          dialect: adapter.dialect,
          principalName: 'unknown',
          isReadOnly: false,
          violations: err.violations,
          checkedAt: new Date().toISOString()
        };
        reports.push(failedReport);

        this.errorLogger(
          JSON.stringify({
            event: 'PREFLIGHT_FATAL_FAILURE',
            adapterId: err.adapterId,
            dialect: adapter.dialect,
            violations: err.violations,
            timestamp: failedReport.checkedAt
          })
        );

        this.lastSummary = {
          allPassed: false,
          totalAdapters: adapterIds.length,
          reports,
          abortedProcess: this.exitOnFailure
        };

        if (this.exitOnFailure) {
          this.exitHandler(1);
        }

        throw new PreflightFatalError(err.adapterId, err.violations);
      }
      throw err;
    }
  }
}
