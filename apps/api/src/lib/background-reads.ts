/**
 * Reads a request started and did not wait for — a stale list refreshed in the
 * background while the old one is served. The process's database client waits
 * for them before it disconnects, so a refresh never runs on a connection that
 * is being closed under it. (A query in flight across `$disconnect` leaves the
 * one shared client unable to answer the next caller: "Engine is not yet
 * connected".) [#1678, Opus S3-11]
 */
const pending = new Set<Promise<unknown>>();

/** How long a close waits for background reads before it disconnects anyway. */
export const BACKGROUND_READS_SETTLE_MS = 5_000;

/** Track a read nobody awaits; the same promise is returned. */
export function trackBackgroundRead<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  const done = (): void => { pending.delete(work); };
  work.then(done, done);
  return work;
}

/** Wait for every tracked read (and any it started), at most `limitMs`. Never throws. */
export async function settleBackgroundReads(limitMs = BACKGROUND_READS_SETTLE_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'late'>((resolve) => {
    // Not unref'd: the bound must hold even when nothing else keeps the process alive. [DS1260 S4]
    timer = setTimeout(() => resolve('late'), limitMs);
  });
  try {
    while (pending.size > 0) {
      if ((await Promise.race([Promise.allSettled([...pending]), deadline])) === 'late') return;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** How many tracked reads are still running (tests). */
export function backgroundReadsPending(): number {
  return pending.size;
}
