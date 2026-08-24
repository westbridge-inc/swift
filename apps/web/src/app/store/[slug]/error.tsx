'use client';

import { useEffect } from 'react';
import { QrState } from '@/components/qr-state/qr-state';

export default function StorefrontError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Keep the diagnostic in the browser console without exposing internals
    // to a customer standing at the counter.
    console.error(error);
  }, [error]);

  return (
    <QrState
      eyebrow="Menu temporarily unavailable"
      title="Swift could not load this store right now"
      retryAction={reset}
    >
      No order was placed and no money moved. Check your connection, try again, or browse another store.
    </QrState>
  );
}
