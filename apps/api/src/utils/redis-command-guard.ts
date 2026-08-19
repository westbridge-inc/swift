export type RedisCommandFailure = {
  command: string;
  error: unknown;
};

type RedisPromiseCommand = (...args: unknown[]) => unknown;

type TrackedCommand = {
  command: string;
  completion: Promise<unknown>;
};

export interface RedisCommandGuard {
  /**
   * Stop retaining command promises, verify that every required command was
   * issued, and await the commands observed up to this checkpoint.
   */
  verifyAndStopTracking(requiredCommands: readonly string[]): Promise<void>;
  /** Stop retaining promises when the caller only needs rejection guards. */
  stopTracking(): void;
}

function hasCatch(value: unknown): value is PromiseLike<unknown> & {
  catch: (onRejected: (error: unknown) => void) => unknown;
} {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function'
    && typeof (value as { catch?: unknown }).catch === 'function';
}

/**
 * Socket.IO Redis adapter 8.3.0 intentionally treats several Redis commands
 * as fire-and-forget. ioredis returns rejecting promises for those commands,
 * so an adapter call that ignores the return value can otherwise become a
 * process-level unhandled rejection.
 *
 * The guard observes (but never replaces) each returned promise. Awaited
 * callers receive the exact original promise and therefore retain its normal
 * rejection semantics. Tracking is only for the bounded startup checkpoint;
 * it must be stopped so runtime publishes do not accumulate in memory.
 */
export function guardRedisCommandPromises<TClient extends object>(
  client: TClient,
  commands: readonly string[],
  reportFailure: (failure: RedisCommandFailure) => void,
): RedisCommandGuard {
  const mutableClient = client as Record<string, unknown>;
  const trackedCommands: TrackedCommand[] = [];
  let tracking = true;

  for (const command of commands) {
    const original = mutableClient[command];
    if (typeof original !== 'function') continue;

    mutableClient[command] = function guardedRedisCommand(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      const result = (original as RedisPromiseCommand).apply(this, args);
      if (!hasCatch(result)) return result;

      // Calling catch marks the original ioredis promise as handled even when
      // the adapter ignores it. The observer must never throw and create a new
      // unhandled rejection of its own.
      void result.catch((error: unknown) => {
        try {
          reportFailure({ command, error });
        } catch {
          // Logging/telemetry failure cannot be allowed to destabilize Redis.
        }
      });

      if (tracking) {
        trackedCommands.push({ command, completion: Promise.resolve(result) });
      }
      return result;
    };
  }

  return {
    async verifyAndStopTracking(requiredCommands: readonly string[]): Promise<void> {
      tracking = false;
      const checkpoint = trackedCommands.splice(0);
      const invokedCommands = new Set(checkpoint.map(({ command }) => command));
      const missingCommands = requiredCommands.filter((command) => !invokedCommands.has(command));

      // Await every observed promise before declaring the adapter ready. A
      // rejected subscription remains a startup failure even though its
      // rejection was also observed by the safety handler above.
      await Promise.all(checkpoint.map(({ completion }) => completion));

      if (missingCommands.length > 0) {
        throw new Error(
          `Socket Redis adapter did not initialize required command(s): ${missingCommands.join(', ')}`,
        );
      }
    },
    stopTracking(): void {
      tracking = false;
      trackedCommands.length = 0;
    },
  };
}
