'use client';

import { useEffect, useState } from 'react';

/** Keep live pages and unsaved input mounted. Queries refetch on reconnect;
 *  only the separate offline fallback document may reload automatically. */
export function OfflineNotice() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    setOffline(!navigator.onLine);
    const disconnected = () => setOffline(true);
    const reconnected = () => setOffline(false);
    window.addEventListener('offline', disconnected);
    window.addEventListener('online', reconnected);
    return () => {
      window.removeEventListener('offline', disconnected);
      window.removeEventListener('online', reconnected);
    };
  }, []);

  if (!offline) return null;
  return <aside role="status" className="mb-4 sw-card p-4">
    <p className="font-bold">You’re offline.</p>
    <p className="text-sm text-[var(--swift-muted)]">Reconnect to keep ordering. Your cart is kept on your account.</p>
  </aside>;
}
