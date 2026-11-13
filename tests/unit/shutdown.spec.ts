import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../../src/bin/shutdown.js';

describe('createShutdown', () => {
  it('does not recurse when closing the server triggers the shutdown again', async () => {
    // Same shape as the SDK: server.close() closes the transport, whose onclose calls the shutdown routine.
    const exit = vi.fn();
    const closeAdapters = vi.fn(async () => undefined);
    let onclose: (() => void) | undefined;
    const closeServer = vi.fn(async () => {
      onclose?.();
    });
    const shutdown = createShutdown({ closeServer, closeAdapters, exit });
    onclose = () => void shutdown();

    await shutdown();

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeAdapters).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('runs once when several signals arrive together', async () => {
    const exit = vi.fn();
    const closeServer = vi.fn(async () => undefined);
    const closeAdapters = vi.fn(async () => undefined);
    const shutdown = createShutdown({ closeServer, closeAdapters, exit });

    await Promise.all([shutdown(), shutdown(), shutdown()]);

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closeAdapters).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still closes the adapters and exits when closing the server fails', async () => {
    const exit = vi.fn();
    const closeAdapters = vi.fn(async () => undefined);
    const shutdown = createShutdown({
      closeServer: async () => {
        throw new Error('EPIPE');
      },
      closeAdapters,
      exit
    });

    await shutdown();

    expect(closeAdapters).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits when closing the adapters fails', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({
      closeServer: async () => undefined,
      closeAdapters: async () => {
        throw new Error('pool already closed');
      },
      exit
    });

    await shutdown();

    expect(exit).toHaveBeenCalledWith(0);
  });
});
