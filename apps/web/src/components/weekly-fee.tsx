'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, apiFetch } from '@/lib/auth';
import { useStoreId } from '@/lib/store-scope';
import { checkoutWords, dueLine, feeDate, feeMoney, FeeCheckoutSession, liveMmg, subscriptionWords, type CheckoutView, type FeeFamily, type FeeSubscription } from '@/lib/weekly-fee';

export function WeeklyFee({ family }: { family: FeeFamily }) {
  const storeId = useStoreId();
  const client = useQueryClient();
  const queryKey = useMemo(() => ['weekly-fee', family, family === 'vendor' ? storeId : null], [family, storeId]);
  const base = `/api/v1/${family}/subscription`;
  const q = useQuery<FeeSubscription>({ queryKey, queryFn: () => apiFetch(base).then((r) => r.data), staleTime: 0, refetchInterval: 60_000 });
  const [view, setView] = useState<CheckoutView>({ checkout: null, busy: false, returned: false, error: '', blocked: false });
  const session = useMemo(() => new FeeCheckoutSession({
    start: (key) => apiFetch(`${base}/mmg-checkout`, { method: 'POST', body: '{}', headers: { 'Idempotency-Key': key } }).then((r) => r.data),
    read: (ref) => apiFetch(`${base}/mmg-checkout/${encodeURIComponent(ref)}`).then((r) => r.data),
    open: async (url) => { window.location.assign(url); },
    refresh: () => { void client.invalidateQueries({ queryKey }); },
  }, () => crypto.randomUUID(), setView, (e) => e instanceof ApiRequestError ? e : {}), [base, client, queryKey]);
  useEffect(() => { session.activate(); return () => session.dispose(); }, [session]);
  useEffect(() => { session.focus(q.data?.latestMmgCheckout); }, [session, q.data?.latestMmgCheckout?.ref]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const focus = () => { void client.invalidateQueries({ queryKey }); session.focus(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [client, queryKey, session]);
  if (q.isLoading) return <p>Loading your weekly fee…</p>;
  if (q.isError || !q.data) return <div role="alert"><p>Could not load your weekly fee.</p><button onClick={() => void q.refetch()}>Try again</button></div>;
  const sub = q.data;
  const action = liveMmg(sub);
  const checkout = view.returned ? view.checkout : view.checkout ?? sub?.latestMmgCheckout;
  const blocked = view.blocked || checkout?.status === 'CONFIRMING' || checkout?.status === 'HELD';
  return <section className="max-w-2xl space-y-6">
    <h1 className="text-2xl font-extrabold">Weekly fee</h1>
    <div className="space-y-4 rounded-2xl border border-black/5 bg-white p-6">
      <p className="text-xl font-bold">{dueLine(sub)}</p>
      <p>{subscriptionWords(checkout?.subscriptionStatus ?? sub.status)}</p>
      {checkout && <p role="status">{checkoutWords(checkout, view.returned)}</p>}
      {view.returned && !checkout && <p role="status">Waiting for MMG…</p>}
      {view.error && <p role="alert">{view.error}</p>}
      {action && !blocked && <button disabled={view.busy} onClick={() => void session.pay()} className="rounded-full bg-[var(--swift-red)] px-6 py-3 font-bold text-white disabled:opacity-50">
        {view.busy ? 'Opening MMG…' : `Pay ${feeMoney(action.amountGyd)} with MMG`}
      </button>}
      <div><button className="text-sm font-semibold underline" onClick={() => { void q.refetch(); session.focus(); }}>Refresh status</button></div>
    </div>
    <p className="text-sm text-[var(--swift-muted)]">The weekly fee is Swift&apos;s only charge, so you keep 100% of everything you earn.</p>
    <h2 className="text-lg font-bold">Recent checkouts</h2>
    {sub.recentCheckouts?.length ? sub.recentCheckouts.map((c) => <div key={c.ref} className="space-y-2 rounded-2xl border border-black/5 bg-white p-5">
      <p className="text-sm text-[var(--swift-muted)]">{feeDate(c.createdAt)} · {feeMoney(c.amountGyd)}</p>
      <p>{checkoutWords(c.ref === view.checkout?.ref ? view.checkout : c, c.ref === view.checkout?.ref && view.returned)}</p>
    </div>) : <p className="text-sm text-[var(--swift-muted)]">No recent checkouts.</p>}
  </section>;
}
