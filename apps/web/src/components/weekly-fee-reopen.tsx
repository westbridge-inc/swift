'use client';

import { useEffect, useState } from 'react';
import { feeExpiry, REOPEN_ALREADY_PAID } from '@/lib/weekly-fee';

/**
 * [MMG reopen] The Back card. The weekly-fee page loads it only when the server
 * grants a reopen (the switch is off by default), so the page's first load does
 * not carry it. At Swift's deadline it goes away on this browser's clock and
 * asks for the fee again, even if the server still grants it.
 */
export default function WeeklyFeeReopen({ expiresAt, busy, onBack, onExpired }: {
  expiresAt: string; busy: boolean; onBack: () => void; onExpired: () => unknown;
}) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const delay = Date.parse(expiresAt) - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(() => { setExpired(true); void onExpired(); }, Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [expiresAt, onExpired]);
  if (expired) return null;
  return <section aria-labelledby="mmg-reopen-title" className="space-y-4 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
    <h3 id="mmg-reopen-title" className="text-lg font-bold">Back to MMG&apos;s page</h3>
    <p className="text-sm text-[var(--swift-muted)]">{feeExpiry(expiresAt)}</p>
    <p className="text-sm font-semibold">{REOPEN_ALREADY_PAID}</p>
    <button disabled={busy} onClick={onBack} className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[var(--swift-red)] px-6 py-3 font-bold text-white disabled:opacity-50">Back to MMG&apos;s page</button>
  </section>;
}
