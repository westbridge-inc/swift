export interface CloseableResource {
  name: string;
  close: () => Promise<unknown>;
}

export function positiveDurationMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Close everything even if one resource rejects or hangs, then surface a
 * single aggregate failure. Promise.race observes late rejections from timed-
 * out close operations, preventing shutdown-time unhandled rejections. */
export async function closeResourcesBounded(
  resources: CloseableResource[],
  timeoutMs: number,
): Promise<void> {
  const results = await Promise.allSettled(
    resources.map((resource) =>
      withTimeout(
        Promise.resolve().then(resource.close),
        timeoutMs,
        `Closing ${resource.name}`,
      ),
    ),
  );
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to close ${errors.length} lifecycle resource(s)`);
  }
}

export function idempotentAsync(operation: () => Promise<void>): () => Promise<void> {
  let operationPromise: Promise<void> | undefined;
  return () => {
    operationPromise ??= operation();
    return operationPromise;
  };
}
