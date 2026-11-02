import { describe, expect, it } from 'vitest';
import { MySqlQueryWatchdog } from '../../src/adapters/mysql/mysql-cancellation.js';

describe('MySqlQueryWatchdog', () => {
  it('registers threadId and cancels query via KILL QUERY <threadId> within 500 ms upon abort signal', async () => {
    const killedThreads: number[] = [];
    const mockControlPool = {
      async execute(sql: string) {
        const match = sql.match(/KILL QUERY\s+(\d+)/i);
        if (match) {
          if (match[1]) killedThreads.push(parseInt(match[1], 10));
        }
        return [[], []] as any;
      }
    };

    const watchdog = new MySqlQueryWatchdog(mockControlPool);
    const controller = new AbortController();
    const startTime = Date.now();

    const watchdogCleanup = watchdog.attachCancellation(54321, controller.signal);

    // Trigger abort
    controller.abort();

    // Verify thread killed
    expect(killedThreads).toContain(54321);
    const elapsedMs = Date.now() - startTime;
    expect(elapsedMs).toBeLessThanOrEqual(500);

    watchdogCleanup();
  });
});
