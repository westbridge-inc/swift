'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, apiFetch } from '@/lib/auth';
import { useStoreId } from '@/lib/store-scope';
import { checkoutReferences, checkoutWords, dueLine, feeDate, feeExpiry, feeMoney, FeeCheckoutSession, liveMmg, REOPEN_ALREADY_PAID, reopenableMmg, subscriptionWords, type CheckoutView, type FeeFamily, type FeeSubscription } from '@/lib/weekly-fee';
import { liveCard } from '@/lib/card-fee';
import { CardPay } from '@/components/card-pay';

/** The dot beside the status word: colour is the second signal, the word is the first. */
const STATUS_DOT: Record<string, string> = {
  TRIAL: 'bg-[var(--swift-success)]', ACTIVE: 'bg-[var(--swift-success)]', PAST_DUE: 'bg-[var(--swift-warning)]',
  SUSPENDED: 'bg-[var(--swift-error)]', CHURNED: 'bg-[var(--swift-error)]',
};

export function WeeklyFee({ family }: { family: FeeFamily }) {
  const storeId = useStoreId();
  // A store change unmounts the whole checkout lifetime, including its view.
  return <WeeklyFeeContext key={`${family}:${storeId ?? 'no-store'}`} family={family} storeId={storeId} />;
}

function WeeklyFeeContext({ family, storeId }: { family: FeeFamily; storeId: string | null }) {
  const client = useQueryClient();
  const queryKey = useMemo(() => ['weekly-fee', family, family === 'vendor' ? storeId : null], [family, storeId]);
  const base = `/api/v1/${family}/subscription`;
  const q = useQuery<FeeSubscription>({ queryKey, queryFn: () => apiFetch(base, undefined, { storeId }).then((r) => r.data), staleTime: 0, refetchInterval: 60_000 });
  const [view, setView] = useState<CheckoutView>({ checkout: null, busy: false, returned: false, error: '', blocked: false });
  // A card Pay now that may still take money hides the MMG button too: one payment at a time.
  const [cardPending, setCardPending] = useState(false);
  const refreshFee = useCallback(() => { void client.invalidateQueries({ queryKey }); }, [client, queryKey]);
  const session = useMemo(() => new FeeCheckoutSession({
    start: (key) => apiFetch(`${base}/mmg-checkout`, { method: 'POST', body: '{}', headers: { 'Idempotency-Key': key } }, { storeId }).then((r) => r.data),
    reopen: (ref, key) => apiFetch(`${base}/mmg-checkout/${encodeURIComponent(ref)}/reopen`, { method: 'POST', body: '{}', headers: { 'Idempotency-Key': key } }, { storeId }).then((r) => r.data),
    read: (ref) => apiFetch(`${base}/mmg-checkout/${encodeURIComponent(ref)}`, undefined, { storeId }).then((r) => r.data),
    open: async (url) => { window.location.assign(url); },
    refresh: () => { void client.invalidateQueries({ queryKey }); },
  }, () => crypto.randomUUID(), setView, (e) => e instanceof ApiRequestError ? e : {}), [base, client, queryKey, storeId]);
  useEffect(() => { session.activate(); return () => session.dispose(); }, [session]);
  useEffect(() => { session.focus(q.data?.latestMmgCheckout); }, [session, q.data?.latestMmgCheckout?.ref]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { session.reconcile(q.data?.latestMmgCheckout, q.data?.recentCheckouts); }, [session, q.data?.latestMmgCheckout, q.data?.recentCheckouts]);
  useEffect(() => {
    const focus = () => { void client.invalidateQueries({ queryKey }); session.focus(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [client, queryKey, session]);
  const reopenExpiresAt = q.data?.reopenableMmgCheckout?.expiresAt;
  const refetch = q.refetch;
  const [, setExpiryTick] = useState(0);
  useEffect(() => {
    if (!reopenExpiresAt) return;
    const delay = Date.parse(reopenExpiresAt) - Date.now();
    if (!(delay > 0)) return;
    const timer = setTimeout(() => { setExpiryTick(Date.now()); void refetch(); }, Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [reopenExpiresAt, refetch]);
  if (q.isLoading) return <p>Loading your weekly fee…</p>;
  if (q.isError || !q.data) return <div role="alert"><p>Could not load your weekly fee.</p><button onClick={() => void q.refetch()}>Try again</button></div>;
  const sub = q.data;
  const action = liveMmg(sub);
  const checkout = view.returned ? view.checkout : view.checkout ?? sub?.latestMmgCheckout;
  const reopen = reopenableMmg(sub, checkout);
  const mmgPending = view.blocked || checkout?.status === 'OPEN' || checkout?.status === 'EXPIRED' || checkout?.status === 'CONFIRMING' || checkout?.status === 'HELD';
  const canReopen = !!reopen && !view.blocked && !cardPending;
  const blocked = mmgPending || cardPending;
  // The card choice exists only when the server says CARD is live.
  const card = liveCard(sub.payActions);
  return <section className="max-w-3xl space-y-6">
    <h1 className="text-2xl font-extrabold">Weekly fee</h1>
    <div className="space-y-3 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--swift-muted)]">Amount due</p>
      <p className="text-2xl font-extrabold sm:text-3xl">{dueLine(sub)}</p>
      <p className="flex items-center gap-2 text-sm font-semibold"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATUS_DOT[checkout?.subscriptionStatus ?? sub.status] ?? 'bg-[var(--swift-muted)]'}`} />{subscriptionWords(checkout?.subscriptionStatus ?? sub.status)}</p>
      {checkout && <p role="status">{checkoutWords(checkout, view.returned)}</p>}
      {view.returned && !checkout && <p role="status">Waiting for MMG…</p>}
      {view.error && <p role="alert">{view.error}</p>}
      <div><button className="min-h-11 text-sm font-semibold underline underline-offset-4" onClick={() => { void q.refetch(); session.focus(); }}>Refresh status</button></div>
    </div>
    {action && !blocked && card && <h2 className="text-lg font-bold">Choose how to pay</h2>}
    <div className={`grid gap-4 ${action && !blocked && card ? 'md:grid-cols-2' : ''}`}>
      {canReopen && reopen && <section aria-labelledby="mmg-reopen-title" className="space-y-4 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        <h3 id="mmg-reopen-title" className="text-lg font-bold">Back to MMG&apos;s page</h3>
        <p className="text-sm text-[var(--swift-muted)]">{feeExpiry(reopen.expiresAt)}</p>
        <p className="text-sm font-semibold">{REOPEN_ALREADY_PAID}</p>
        <button disabled={view.busy} onClick={() => void session.reopen(reopen.ref)} className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[var(--swift-red)] px-6 py-3 font-bold text-white disabled:opacity-50">Back to MMG&apos;s page</button>
      </section>}
      {action && !blocked && <section aria-labelledby="mmg-pay-title" className="flex flex-col gap-4 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--swift-red-50)] text-xs font-extrabold text-[var(--swift-red-600)]">MMG</span>
          <div className="min-w-0">
            <h3 id="mmg-pay-title" className="text-lg font-bold">Pay with MMG</h3>
            <p className="text-sm text-[var(--swift-muted)]">Opens MMG&apos;s page, then brings you back to Swift.</p>
          </div>
        </div>
        <button disabled={view.busy} onClick={() => void session.pay()} className="mt-auto inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[var(--swift-red)] px-6 py-3 font-bold text-white disabled:opacity-50">
          {view.busy ? 'Opening MMG…' : `Pay ${feeMoney(action.amountGyd)} with MMG`}
        </button>
      </section>}
      <CardPay family={family} storeId={storeId} card={card} otherPaymentPending={mmgPending} refresh={refreshFee} onPaymentPending={setCardPending} />
    </div>
    <p className="text-sm text-[var(--swift-muted)]">The weekly fee is Swift&apos;s only charge, so you keep 100% of everything you earn.</p>
    <h2 className="text-lg font-bold">Recent checkouts</h2>
    {sub.recentCheckouts?.length ? sub.recentCheckouts.map((c) => {
      const shown = c.ref === view.checkout?.ref ? view.checkout : c;
      return <div key={c.ref} className="space-y-2 rounded-2xl border border-black/5 bg-white p-5">
        <p className="text-sm text-[var(--swift-muted)]">{feeDate(c.createdAt)} · {feeMoney(c.amountGyd)}</p>
        <p>{checkoutWords(shown, c.ref === view.checkout?.ref && view.returned)}</p>
        {/* The references support finds this payment by: ours always, MMG's once confirmed. */}
        {checkoutReferences(shown).map((r) => <p key={r.label} className="text-sm text-[var(--swift-muted)]">{r.label}: <span className="font-mono">{r.value}</span></p>)}
      </div>;
    }) : <p className="text-sm text-[var(--swift-muted)]">No recent checkouts.</p>}
  </section>;
}
