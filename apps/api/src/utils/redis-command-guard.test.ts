import { describe, expect, it, vi } from 'vitest';
import { guardRedisCommandPromises } from './redis-command-guard';

describe('guardRedisCommandPromises', () => {
  it('observes ignored rejections without changing the promise returned to awaited callers', async () => {
    const failure = new Error('publish unavailable');
    const commandPromise = Promise.reject(failure);
    const catchSpy = vi.spyOn(commandPromise, 'catch');
    const client = { publish: vi.fn(() => commandPromise) };
    const reportFailure = vi.fn();
    const guard = guardRedisCommandPromises(client, ['publish'], reportFailure);
    guard.stopTracking();

    const returned = client.publish();

    expect(returned).toBe(commandPromise);
    expect(catchSpy).toHaveBeenCalledOnce();
    await expect(returned).rejects.toBe(failure);
    await Promise.resolve();
    expect(reportFailure).toHaveBeenCalledWith({ command: 'publish', error: failure });
  });

  it('contains an actually ignored rejection even when the failure reporter throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const client = { publish: vi.fn(() => Promise.reject(new Error('redis down'))) };
      const guard = guardRedisCommandPromises(client, ['publish'], () => {
        throw new Error('logger failed');
      });
      guard.stopTracking();

      // Deliberately do not retain or await the command Promise.
      void client.publish();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('awaits and verifies the default namespace subscription checkpoint', async () => {
    let resolvePattern!: () => void;
    let resolveChannels!: () => void;
    const pattern = new Promise<void>((resolve) => { resolvePattern = resolve; });
    const channels = new Promise<void>((resolve) => { resolveChannels = resolve; });
    const client = {
      psubscribe: vi.fn(() => pattern),
      subscribe: vi.fn(() => channels),
    };
    const guard = guardRedisCommandPromises(
      client,
      ['psubscribe', 'subscribe'],
      vi.fn(),
    );

    client.psubscribe();
    client.subscribe();
    let ready = false;
    const checkpoint = guard
      .verifyAndStopTracking(['psubscribe', 'subscribe'])
      .then(() => { ready = true; });

    await Promise.resolve();
    expect(ready).toBe(false);
    resolvePattern();
    await Promise.resolve();
    expect(ready).toBe(false);
    resolveChannels();
    await checkpoint;
    expect(ready).toBe(true);
  });

  it('fails readiness when an adapter subscription is missing or rejects', async () => {
    const missingClient = { subscribe: vi.fn(() => Promise.resolve()) };
    const missingGuard = guardRedisCommandPromises(
      missingClient,
      ['psubscribe', 'subscribe'],
      vi.fn(),
    );
    missingClient.subscribe();
    await expect(
      missingGuard.verifyAndStopTracking(['psubscribe', 'subscribe']),
    ).rejects.toThrow('did not initialize required command(s): psubscribe');

    const failure = new Error('subscription rejected');
    const reportFailure = vi.fn();
    const rejectingClient = { psubscribe: vi.fn(() => Promise.reject(failure)) };
    const rejectingGuard = guardRedisCommandPromises(
      rejectingClient,
      ['psubscribe'],
      reportFailure,
    );
    rejectingClient.psubscribe();
    await expect(rejectingGuard.verifyAndStopTracking(['psubscribe'])).rejects.toBe(failure);
    expect(reportFailure).toHaveBeenCalledWith({ command: 'psubscribe', error: failure });
  });
});
