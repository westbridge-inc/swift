'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ReasonDialogProvider } from '@/components/mc/ReasonDialog';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
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
