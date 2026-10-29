'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ReasonDialogProvider } from '@/components/mc/ReasonDialog';
import { retryUnlessRefused } from '@/lib/query-retry';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // [ADMIN-AUDIT S3-1] a 4xx is final at once; a network failure or a 5xx is tried again
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: retryUnlessRefused },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* [MC-PR1] the in-page reason panel, one for the whole console */}
      <ReasonDialogProvider>{children}</ReasonDialogProvider>
    </QueryClientProvider>
  );
}
