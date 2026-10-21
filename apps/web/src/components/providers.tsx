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
export function Providers({ children, offline = 'pause' }: { children: React.ReactNode; offline?: 'pause' | 'fail' }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 5_000, refetchOnWindowFocus: true, ...(offline === 'fail' ? { networkMode: 'always' as const } : {}) },
          ...(offline === 'fail' ? { mutations: { networkMode: 'always' as const } } : {}),
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
