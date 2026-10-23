import { useEffect, useState } from 'react';
import { retryImport } from '@/lib/chunk-retry';

// [PERF] A part of a page that shows only after a tap (an order's window) ships
// in its own chunk, so the page's first load does not carry it. The chunk is
// fetched in the background as soon as the page mounts, so the tap finds it
// already here and the part draws in the same frame as the tap.
//
// It is drawn WITHOUT Suspense on purpose: once a Suspense fallback has shown,
// React holds the real content back for up to ~300 ms, which would put a
// placeholder in front of a tap that had everything it needed.
//
// A failed background fetch never breaks the page (nobody asked for the part
// yet). When the part is needed it is fetched again; if that fails too (each
// fetch already tries twice, lib/chunk-retry), the failure goes to the page's
// error screen, which reloads once by itself for a chunk failure.

export function preloadedPart<T>(load: () => Promise<T>) {
  const fetchPart = retryImport(load);
  let part: T | undefined;
  let pending: Promise<T> | null = null;

  /** Start (or join) the one fetch of the part. */
  const preload = (): Promise<T> => {
    pending ??= fetchPart().then(
      (value) => { part = value; return value; },
      (error: unknown) => { pending = null; throw error; },
    );
    return pending;
  };

  /** The part, once it is here (undefined until then). Fetching starts at mount. */
  function usePart(needed: boolean): T | undefined {
    const [, arrived] = useState(0);
    const [failure, setFailure] = useState<{ error: unknown; needed: boolean } | null>(null);
    useEffect(() => {
      if (part !== undefined) return;
      if (failure && !needed) return; // a background failure waits until the part is asked for
      let live = true;
      preload().then(
        () => { if (live) arrived((n) => n + 1); },
        (error: unknown) => { if (live) setFailure({ error, needed }); },
      );
      return () => { live = false; };
    }, [needed]); // eslint-disable-line react-hooks/exhaustive-deps -- a failure is retried only when the part is asked for
    if (part !== undefined) return part;
    if (failure?.needed) throw failure.error;
    return undefined;
  }

  return { preload, usePart };
}
