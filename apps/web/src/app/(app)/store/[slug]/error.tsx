'use client';

import { useEffect } from 'react';
import { QrState } from '@/components/qr-state/qr-state';
import { useChunkRecovery } from '@/lib/chunk-retry';

export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // [PERF #7] Menu code that failed to arrive: reload once by itself; "Try again" reloads.
  const { reloading, retry } = useChunkRecovery(error, reset);
  useEffect(() => {
    // Keep the diagnostic in the browser console without exposing internals
    // to a customer standing at the counter.
    console.error(error);
  }, [error]);

  if (reloading) return null;
  return (
    <QrState
      embedded
      eyebrow="Menu temporarily unavailable"
      title="Swift could not load this store right now"
      retryAction={retry}
    >
      No order was placed and no money moved. Check your connection, try again, or browse another store.
    </QrState>
  );
}
