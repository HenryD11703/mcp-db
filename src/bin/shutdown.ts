/**
 * Builds the shutdown routine of the stdio server.
 *
 * It runs at most once. Closing the MCP server closes its transport, and the transport reports that through
 * `onclose`; if `onclose` starts the shutdown again, the two call each other until the stack overflows. Every later
 * call therefore returns the promise of the first one.
 */
export interface ShutdownSteps {
  closeServer: () => Promise<void>;
  closeAdapters: () => Promise<void>;
  exit: (code: number) => void;
}

export function createShutdown(steps: ShutdownSteps): () => Promise<void> {
  let running: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    // Yield before the first step, so `running` is already set if that step calls back into the shutdown.
    await Promise.resolve();
    // Each step is attempted even if the previous one failed: a broken pipe must not leave pools open.
    try {
      await steps.closeServer();
    } catch {
      // Ignore errors during process exit
    }
    try {
      await steps.closeAdapters();
    } catch {
      // Ignore errors during process exit
    }
    steps.exit(0);
  };

  return () => {
    running ??= run();
    return running;
  };
}
