import { idempotentAsync, positiveDurationMs, withTimeout } from './async-lifecycle';

export type FatalProcessEvent = 'unhandledRejection' | 'uncaughtException';
export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface ProcessEventSource {
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  off: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export interface ProcessLifecycleOptions {
  cleanup: () => Promise<unknown>;
  markNotReady: () => void;
  exit: (code: number) => void;
  onSignal: (signal: ShutdownSignal) => void;
  onFatal: (event: FatalProcessEvent, error: unknown) => void;
  onCleanupError: (error: unknown) => void;
  eventSource?: ProcessEventSource;
  cleanupTimeoutMs?: number;
  signals?: readonly ShutdownSignal[];
}

export interface ProcessLifecycleController {
  shutdown: (signal: ShutdownSignal) => Promise<void>;
  fatal: (event: FatalProcessEvent, error: unknown) => Promise<void>;
  dispose: () => void;
  isTerminating: () => boolean;
}

/**
 * Installs exactly one owned set of process handlers. Fatal events immediately
 * withdraw readiness, share one bounded cleanup with signal shutdown, and
 * always win the exit-code race. The injected event source/exit function keeps
 * the contract deterministic in tests without terminating Vitest.
 */
export function installProcessLifecycle(
  options: ProcessLifecycleOptions,
): ProcessLifecycleController {
  const eventSource = options.eventSource ?? process as unknown as ProcessEventSource;
  const timeoutMs = options.cleanupTimeoutMs
    ?? positiveDurationMs(process.env['PROCESS_SHUTDOWN_TIMEOUT_MS'], 15_000);
  const signals = options.signals ?? ['SIGINT', 'SIGTERM'];
  let disposed = false;
  let terminationPromise: Promise<void> | undefined;
  let requestedExitCode = 0;
  let exitCalled = false;

  const cleanup = idempotentAsync(async () => {
    await withTimeout(
      Promise.resolve().then(options.cleanup),
      timeoutMs,
      'Process lifecycle cleanup',
    );
  });

  const signalListeners = new Map<ShutdownSignal, (...args: unknown[]) => void>();
  const unhandledRejectionListener = (...args: unknown[]) => {
    void fatal('unhandledRejection', args[0]);
  };
  const uncaughtExceptionListener = (...args: unknown[]) => {
    void fatal('uncaughtException', args[0]);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    eventSource.off('unhandledRejection', unhandledRejectionListener);
    eventSource.off('uncaughtException', uncaughtExceptionListener);
    for (const [signal, listener] of signalListeners) eventSource.off(signal, listener);
  };

  const reportCleanupError = (error: unknown) => {
    try {
      options.onCleanupError(error);
    } catch {
      // A logger/telemetry failure must never prevent the required exit.
    }
  };

  const markNotReady = () => {
    try {
      options.markNotReady();
    } catch (error) {
      reportCleanupError(error);
      requestedExitCode = 1;
    }
  };

  const terminate = (): Promise<void> => {
    terminationPromise ??= (async () => {
      try {
        await cleanup();
      } catch (error) {
        requestedExitCode = 1;
        reportCleanupError(error);
      } finally {
        dispose();
        if (!exitCalled) {
          exitCalled = true;
          options.exit(requestedExitCode);
        }
      }
    })();
    return terminationPromise;
  };

  const shutdown = (signal: ShutdownSignal): Promise<void> => {
    try {
      options.onSignal(signal);
    } catch (error) {
      requestedExitCode = 1;
      reportCleanupError(error);
    }
    markNotReady();
    return terminate();
  };

  const fatal = (event: FatalProcessEvent, error: unknown): Promise<void> => {
    requestedExitCode = 1;
    try {
      options.onFatal(event, error);
    } catch (callbackError) {
      reportCleanupError(callbackError);
    }
    markNotReady();
    return terminate();
  };

  eventSource.on('unhandledRejection', unhandledRejectionListener);
  eventSource.on('uncaughtException', uncaughtExceptionListener);
  for (const signal of signals) {
    const listener = () => { void shutdown(signal); };
    signalListeners.set(signal, listener);
    eventSource.on(signal, listener);
  }

  return {
    shutdown,
    fatal,
    dispose,
    isTerminating: () => terminationPromise !== undefined,
  };
}
