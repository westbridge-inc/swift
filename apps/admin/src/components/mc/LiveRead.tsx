'use client';

import { useEffect, useReducer, useRef } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { errorStatus, type Envelope } from '@/lib/api';
import { gyTime } from '@/lib/dates';
import { QueryFailed } from './QueryFailed';

// ---------------------------------------------------------------------------
// [LIVE READ] A list a responder acts on: the Safety board and Ops alerts. An "all clear" on these pages must rest on a read
// that really ran and came back, so a read that could not run, never returned or brought back no list (lib/api.ts readWithin)
// is a failed read, and a failed refresh keeps the last good rows on screen with a note.
// ---------------------------------------------------------------------------

/** The server said this account may not read: the cards go. Anything else (a 429, a 5xx, no network) leaves them on screen. */
export const refusedRead = (error: unknown) => { const status = errorStatus(error); return status === 401 || status === 403; };

/** Keep reading: offline, behind a hidden tab, and at once on opening or coming back. A failure shows at once, not after retries. */
export const BOARD_READ = { networkMode: 'always', retry: false, staleTime: 0, refetchOnWindowFocus: 'always', refetchIntervalInBackground: true } as const;

/** Now, kept current every second, and on the events a waking page may fire: which of them fires depends on the browser. */
export function useNow(): number {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(tick, 1_000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    window.addEventListener('pageshow', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('pageshow', tick);
    };
  }, []);
  return Date.now();
}

/** A list's first read, a refusal, a failed refresh, or the cap: said in words, never as an empty list. */
export function ListState<T>({ query, what, onRetry, cap }: { query: UseQueryResult<Envelope<T[]>>; what: string; onRetry: () => void; cap?: number }) {
  // With no data, each new read clears the error: the failure stays up while it runs, instead of flickering back to Loading.
  const lastError = useRef<unknown>(null);
  if (query.error) lastError.current = query.error;
  if (query.isPending && !lastError.current) return <div className="mc-card" aria-busy="true">Loading {what}…</div>;
  if (query.isPending || (query.isError && (refusedRead(query.error) || !query.data))) {
    return <QueryFailed error={query.error ?? lastError.current} what={what} onRetry={onRetry} retrying={query.isFetching} className="mb-3" />;
  }
  if (query.isError) {
    return <p role="alert" className="mc-note mc-note-bad mb-3">This list could not refresh. It shows what it last read at {gyTime(query.dataUpdatedAt)}.</p>;
  }
  if (cap !== undefined && (query.data?.data.length ?? 0) >= cap) {
    return <p className="mc-note mc-note-warn mb-3">Showing the first {cap}. There may be more.</p>;
  }
  return null;
}
