'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * [UI-SWEEP U22] `offline="fail"` (the partner consoles): a request made
 * offline FAILS instead of pausing. A paused query is neither loading, nor
 * failed, nor answered, and the console pages read that as empty: "No items
 * match.", "No earner profile on this account". A failure shows the page's
 * "Couldn't load …" state, and every query refetches on reconnect.
 */
/**
 * [SPEED 30 Oct] `keepFor`: how long a page's answers stay in memory after the
 * page closes (react-query's gcTime; its default is 5 minutes). The business
 * console keeps them longer so a tab opened again shows what it showed while it
 * re-reads in the background, instead of loading from nothing.
 */
export function Providers({ children, offline = 'pause', keepFor }: { children: React.ReactNode; offline?: 'pause' | 'fail'; keepFor?: number }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true, ...(offline === 'fail' ? { networkMode: 'always' as const } : {}), ...(keepFor ? { gcTime: keepFor } : {}) },
          ...(offline === 'fail' ? { mutations: { networkMode: 'always' as const } } : {}),
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
