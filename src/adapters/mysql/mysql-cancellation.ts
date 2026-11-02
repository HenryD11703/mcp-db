export interface MySqlControlExecutor {
  execute(sql: string, values?: ReadonlyArray<unknown>): Promise<unknown>;
}

export class MySqlQueryWatchdog {
  private readonly controlExecutor: MySqlControlExecutor;

  constructor(controlExecutor: MySqlControlExecutor) {
    this.controlExecutor = controlExecutor;
  }

  public attachCancellation(
    threadId: number | undefined,
    signal?: AbortSignal
  ): () => void {
    if (!signal || threadId === undefined) {
      return () => {};
    }

    if (signal.aborted) {
      this.killThread(threadId);
      return () => {};
    }

    const abortHandler = () => {
      this.killThread(threadId);
    };

    signal.addEventListener('abort', abortHandler, { once: true });

    return () => {
      signal.removeEventListener('abort', abortHandler);
    };
  }

  public killThread(threadId: number): void {
    const killSql = `KILL QUERY ${threadId}`;
    this.controlExecutor.execute(killSql).catch((err) => {
      // Ignore errors if query already terminated or thread disappeared
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Unknown thread id') && !msg.includes('1094')) {
        // Non-fatal logging or silent swallow for cancelled queries
      }
    });
  }
}
