'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { hasProviderProfile, restoreSession, sessionProbe } from '@/lib/auth';
import { getProviderFee } from '@/lib/provider-fee-api';

/** [REVIEW-M #2238 S4-2] The pro's own MMG checkout was started in the last two hours: the return is theirs. */
const RECENT_CHECKOUT_MS = 2 * 60 * 60 * 1000;
async function proCheckoutJustStarted(): Promise<boolean> {
  try {
    const at = Date.parse(((await getProviderFee())?.data as { latestMmgCheckout?: { createdAt?: string } | null } | null)?.latestMmgCheckout?.createdAt ?? '');
    return Number.isFinite(at) && Date.now() - at < RECENT_CHECKOUT_MS;
  } catch {
    return false;
  }
}

/** The return document carries no identity. Resolve only from this session. */
export function WeeklyFeeDestination() {
  const router = useRouter();
  const [choice, setChoice] = useState<'loading' | 'both' | 'none'>('loading');
  const [portalLabel, setPortalLabel] = useState('Earner weekly fee');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let session = await sessionProbe();
      if (!session.ok) session = await restoreSession();
      if (cancelled) return;
      if (!session.ok) { router.replace('/login?next=%2Fweekly-fee'); return; }
      const roles = Array.isArray(session.user?.['roles']) ? session.user['roles'] : [];
      const vendor = roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!session.user?.['vendorOwner'];
      const mover = roles.some((r) => ['MOVER', 'RIDER', 'DRIVER'].includes(r));
      // [BILL-PRO PR6] A pro's MMG return lands on their own weekly fee (the portal's provider block).
      // [REVIEW-M #2238 S4-2] A store owner who is also a pro returns to the fee whose checkout they just left: their
      // pro fee when they started its checkout in the last two hours, otherwise they choose (the pro fee is a choice).
      const pro = await hasProviderProfile();
      if (cancelled) return;
      if (vendor && pro && await proCheckoutJustStarted()) { if (!cancelled) router.replace('/portal/weekly-fee'); return; }
      if (cancelled) return;
      if (vendor && (mover || pro)) {
        setPortalLabel(mover && pro ? 'Earner and service provider weekly fees' : pro ? 'Service provider weekly fee' : 'Earner weekly fee');
        setChoice('both');
      }
      else if (vendor) router.replace('/dashboard/weekly-fee');
      else if (mover || pro) router.replace('/portal/weekly-fee');
      else setChoice('none');
    })();
    return () => { cancelled = true; };
  }, [router]);
  return <main id="main" tabIndex={-1} className="mx-auto max-w-lg space-y-6 px-6 py-16">
    <h1 className="sw-title">Weekly fee</h1>
    {choice === 'loading' && <p>Opening your weekly fee…</p>}
    {choice === 'none' && <p>No business or earner profile on this account.</p>}
    {choice === 'both' && <>
      <p>Which weekly fee would you like to view?</p>
      <Link className="block font-semibold underline" href="/dashboard/weekly-fee">Business weekly fee</Link>
      <Link className="block font-semibold underline" href="/portal/weekly-fee">{portalLabel}</Link>
    </>}
  </main>;
}
