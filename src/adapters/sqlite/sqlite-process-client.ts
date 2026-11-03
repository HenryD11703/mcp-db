import { spawn, type ChildProcess } from 'node:child_process';
import { QueryCancelledError, QueryExecutionTimeoutError } from '../../core/errors.js';

/**
 * SQLite runs synchronously inside native code, so a heavy statement would freeze the MCP server
 * and an AbortSignal could never fire. A worker thread does not help either: V8 cannot interrupt
 * `sqlite3_step`, so a terminated thread keeps spinning. Every statement therefore runs in a child
 * process that is killed with SIGKILL on abort or timeout and respawned on the next call.
 */
const CHILD_SOURCE = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.DB_MCP_SQLITE_FILE, {
  readOnly: true,
  timeout: Number(process.env.DB_MCP_SQLITE_BUSY_MS) || 5000
});
db.exec('PRAGMA query_only = ON');
process.on('disconnect', () => process.exit(0));
const reply = (msg) => { if (process.connected) { try { process.send(msg); } catch { process.exit(0); } } };
process.on('message', (req) => {
  try {
    const stmt = db.prepare(req.sql);
    const columns = typeof stmt.columns === 'function'
      ? stmt.columns().map((c) => ({ name: c.name, type: c.type == null ? null : String(c.type) }))
      : [];
    const max = req.maxRows > 0 ? req.maxRows : Infinity;
    const rows = [];
    for (const row of stmt.iterate(...req.params)) {
      rows.push({ ...row });
      if (rows.length >= max) break;
    }
    reply({ id: req.id, ok: true, rows, columns });
  } catch (e) {
    reply({ id: req.id, ok: false, message: String((e && e.message) || e), code: e && (e.code || e.errcode) });
  }
});
reply({ ready: true });
`;

export interface SqliteRunRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly maxRows?: number;
}

export interface SqliteRunResult {
  readonly rows: Array<Record<string, unknown>>;
  readonly columns: ReadonlyArray<{ name: string; type: string | null }>;
}

type Reply =
  | { ready: true }
  | { id: number; ok: true; rows: Array<Record<string, unknown>>; columns: SqliteRunResult['columns'] }
  | { id: number; ok: false; message: string; code?: unknown };

export class SqliteProcessClient {
  private child: ChildProcess | null = null;
  private ready: Promise<ChildProcess> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(
    private readonly adapterId: string,
    private readonly filePath: string,
    private readonly busyTimeoutMs: number,
    private readonly defaultTimeoutMs: number
  ) {}

  /** Statements run one at a time so killing the child only ever aborts the active one. */
  public run(request: SqliteRunRequest, signal?: AbortSignal, timeoutMs?: number): Promise<SqliteRunResult> {
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    const result = this.tail.then(
      () => this.execute(request, signal, effectiveTimeout),
      () => this.execute(request, signal, effectiveTimeout)
    );
    this.tail = result.catch(() => undefined);
    return result;
  }

  public async close(): Promise<void> {
    this.kill();
  }

  private async execute(request: SqliteRunRequest, signal: AbortSignal | undefined, timeoutMs: number): Promise<SqliteRunResult> {
    if (signal?.aborted) throw new QueryCancelledError(this.adapterId);

    const child = await this.ensureChild();
    if (signal?.aborted) throw new QueryCancelledError(this.adapterId);

    const id = this.nextId++;
    return new Promise<SqliteRunResult>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
        this.idle(child);
        action();
      };

      const onMessage = (reply: Reply): void => {
        if (!('id' in reply) || reply.id !== id) return;
        finish(() => {
          if (reply.ok) resolve({ rows: reply.rows, columns: reply.columns });
          else reject(Object.assign(new Error(reply.message), { code: reply.code }));
        });
      };
      const onError = (err: Error): void => finish(() => reject(err));
      const onExit = (): void => finish(() => reject(new Error('SQLite process terminated unexpectedly.')));
      const onAbort = (): void =>
        finish(() => {
          this.kill();
          reject(new QueryCancelledError(this.adapterId));
        });
      const timer = setTimeout(
        () =>
          finish(() => {
            this.kill();
            reject(new QueryExecutionTimeoutError(this.adapterId, timeoutMs));
          }),
        timeoutMs
      );

      child.on('message', onMessage);
      child.on('error', onError);
      child.on('exit', onExit);
      signal?.addEventListener('abort', onAbort, { once: true });
      // The host must stay alive while a statement is in flight.
      child.ref();
      child.channel?.ref();
      child.send({ id, sql: request.sql, params: request.params.map(toSqliteValue), maxRows: request.maxRows ?? 0 });
    });
  }

  private ensureChild(): Promise<ChildProcess> {
    if (this.child && this.ready) return this.ready;

    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--max-old-space-size=256', '-e', CHILD_SOURCE], {
      // Only what the child needs: no inherited credentials or connection strings.
      env: { DB_MCP_SQLITE_FILE: this.filePath, DB_MCP_SQLITE_BUSY_MS: String(this.busyTimeoutMs) },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      serialization: 'advanced',
      windowsHide: true
    });
    this.child = child;

    this.ready = new Promise<ChildProcess>((resolve, reject) => {
      const cleanup = (): void => {
        child.off('message', onMessage);
        child.off('error', onFail);
        child.off('exit', onExit);
      };
      const onMessage = (msg: Reply): void => {
        if (!('ready' in msg)) return;
        cleanup();
        // Once started, an idle child must not keep the host process alive.
        this.idle(child);
        resolve(child);
      };
      const onFail = (err: Error): void => {
        cleanup();
        this.forget(child);
        reject(err);
      };
      const onExit = (code: number | null): void =>
        onFail(new Error(`SQLite process exited during startup (code ${code ?? 'unknown'}); node:sqlite needs Node.js 22.16+ and a readable database file.`));
      child.on('message', onMessage);
      child.on('error', onFail);
      child.on('exit', onExit);
    });
    child.once('exit', () => this.forget(child));
    return this.ready;
  }

  private idle(child: ChildProcess): void {
    child.unref();
    child.channel?.unref();
  }

  private forget(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.ready = null;
    }
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && child.exitCode === null) child.kill('SIGKILL');
  }
}

function toSqliteValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}
