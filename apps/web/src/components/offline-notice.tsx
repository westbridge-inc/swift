'use client';

import { useEffect, useState } from 'react';

/** A paused query can still have useful data. Keep it visible and explain why
 *  it cannot update; reload only after this screen actually showed offline. */
export function OfflineNotice() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let shown = !navigator.onLine;
    setOffline(shown);
    const disconnected = () => { shown = true; setOffline(true); };
    const reconnected = () => {
      if (shown) { shown = false; window.location.reload(); }
    };
    window.addEventListener('offline', disconnected);
    window.addEventListener('online', reconnected);
    return () => {
      window.removeEventListener('offline', disconnected);
      window.removeEventListener('online', reconnected);
    };
  }, []);

  if (!offline) return null;
  return <aside role="status" className="mb-4 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4">
    <p className="font-bold">You’re offline.</p>
    <p className="text-sm text-[var(--swift-muted)]">Reconnect to keep ordering. Your cart is kept on your account.</p>
    <button type="button" onClick={() => window.location.reload()} className="mt-2 rounded-full bg-[var(--swift-red)] px-4 py-2 font-semibold text-white">Try again</button>
  </aside>;
}
