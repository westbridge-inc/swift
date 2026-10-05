'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { currentSessionProof, restoreSession, sessionProbe } from '@/lib/auth';

/** The return document carries no identity. Resolve only from this session. */
export function WeeklyFeeDestination() {
  const router = useRouter();
  const [choice, setChoice] = useState<'loading' | 'both' | 'none'>('loading');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let session = await currentSessionProof(sessionProbe());
      if (session.signedOut) {
        const restored = await currentSessionProof(restoreSession());
        if (restored.ok || restored.signedOut) session = restored;
      }
      if (cancelled) return;
      if (!session.ok) { if (session.signedOut) router.replace('/login?next=%2Fweekly-fee'); return; }
      const roles = Array.isArray(session.user?.['roles']) ? session.user['roles'] : [];
      const vendor = roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!session.user?.['vendorOwner'];
      const mover = roles.some((r) => ['MOVER', 'RIDER', 'DRIVER'].includes(r));
      if (vendor && mover) setChoice('both');
      else if (vendor) router.replace('/dashboard/weekly-fee');
      else if (mover) router.replace('/portal/weekly-fee');
      else setChoice('none');
    })();
    return () => { cancelled = true; };
  }, [router]);
  return <main className="mx-auto max-w-lg space-y-6 px-6 py-16">
    <h1 className="text-2xl font-extrabold">Weekly fee</h1>
    {choice === 'loading' && <p>Opening your weekly fee…</p>}
    {choice === 'none' && <p>No business or earner profile on this account.</p>}
    {choice === 'both' && <>
      <p>Which weekly fee would you like to view?</p>
      <Link className="block font-semibold underline" href="/dashboard/weekly-fee">Business weekly fee</Link>
      <Link className="block font-semibold underline" href="/portal/weekly-fee">Earner weekly fee</Link>
    </>}
  </main>;
}
