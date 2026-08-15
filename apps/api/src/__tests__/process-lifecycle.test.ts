import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installProcessLifecycle } from '../utils/process-lifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('fatal process lifecycle', () => {
  it('marks not-ready, cleans once, exits nonzero, and removes owned handlers', async () => {
    const source = new EventEmitter();
    const cleanupGate = deferred();
    const cleanup = vi.fn(() => cleanupGate.promise);
    const markNotReady = vi.fn();
    const exit = vi.fn();
    const onFatal = vi.fn();
    const controller = installProcessLifecycle({
      cleanup,
      markNotReady,
      exit,
      onSignal: vi.fn(),
      onFatal,
      onCleanupError: vi.fn(),
      eventSource: source,
      cleanupTimeoutMs: 1_000,
    });

    expect(source.listenerCount('unhandledRejection')).toBe(1);
    expect(source.listenerCount('uncaughtException')).toBe(1);
    source.emit('unhandledRejection', new Error('first fatal'));
    source.emit('uncaughtException', new Error('second fatal'));
    await Promise.resolve();

    expect(markNotReady).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledTimes(2);
    cleanupGate.resolve();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(source.listenerCount('unhandledRejection')).toBe(0);
    expect(source.listenerCount('uncaughtException')).toBe(0);
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
    expect(controller.isTerminating()).toBe(true);
  });

  it('upgrades an in-flight graceful shutdown to a fatal nonzero exit', async () => {
    const source = new EventEmitter();
    const cleanupGate = deferred();
    const exit = vi.fn();
    const controller = installProcessLifecycle({
      cleanup: vi.fn(() => cleanupGate.promise),
      markNotReady: vi.fn(),
      exit,
      onSignal: vi.fn(),
      onFatal: vi.fn(),
      onCleanupError: vi.fn(),
      eventSource: source,
      cleanupTimeoutMs: 1_000,
    });

    const graceful = controller.shutdown('SIGTERM');
    const fatal = controller.fatal('unhandledRejection', new Error('during drain'));
    expect(fatal).toBe(graceful);
    cleanupGate.resolve();
    await fatal;

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('bounds a hung cleanup and still performs the required nonzero exit', async () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    const cleanupError = vi.fn();
    const controller = installProcessLifecycle({
      cleanup: () => new Promise(() => undefined),
      markNotReady: vi.fn(),
      exit,
      onSignal: vi.fn(),
      onFatal: vi.fn(),
      onCleanupError: cleanupError,
      eventSource: source,
      cleanupTimeoutMs: 20,
    });
    const startedAt = Date.now();

    await controller.fatal('uncaughtException', new Error('fatal'));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(cleanupError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/timed out after 20ms/) }),
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uses exit zero only for a successful graceful signal cleanup', async () => {
    const source = new EventEmitter();
    const exit = vi.fn();
    const markNotReady = vi.fn();
    const controller = installProcessLifecycle({
      cleanup: vi.fn(async () => undefined),
      markNotReady,
      exit,
      onSignal: vi.fn(),
      onFatal: vi.fn(),
      onCleanupError: vi.fn(),
      eventSource: source,
      cleanupTimeoutMs: 1_000,
    });

    await controller.shutdown('SIGINT');

    expect(markNotReady).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
