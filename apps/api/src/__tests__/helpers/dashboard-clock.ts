import { vi } from 'vitest';

/** A dashboard expectation and its successive request reads share one Date
 * snapshot. Real timers, sockets and database operations continue to run. */
export async function withDashboardClock<T>(at: number, read: () => Promise<T>): Promise<T> {
  const alreadyFrozen = vi.isFakeTimers();
  const previous = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  try { return await read(); }
  finally {
    if (alreadyFrozen) vi.setSystemTime(previous);
    else vi.useRealTimers();
  }
}
