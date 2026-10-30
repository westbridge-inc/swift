'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, apiFetch } from '@/lib/auth';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { isStepUpDismissed, useStepUp } from '@/lib/step-up';
import { DataUnavailable } from '@/components/data-unavailable';
import { CheckingLatest, useCheckingLatest } from '@/components/checking-latest';
import { feeDate, feeMoney } from '@/lib/fee-status';
import {
  CHAIN_COPY, CHAIN_FEE_PATH, ChainCheckoutSession, branchCount, chainBranchWords, chainCheckoutReferences, chainCheckoutWords, chainConfirmed,
  chainShares, chainUnsettled, dueBranches, type ChainFees, type ChainView,
} from '@/lib/chain-fee';

/**
 * [ENTERPRISE E1b · owner 29 Oct 2026] "Pay all my branches" (MMG-CHECKOUT-API.md section 12), the phone's screen
 * (apps/mobile VendorPayAllScreen) on the web: each branch with what its own Pay would charge now, the total, and ONE
 * MMG checkout for every branch that is due, after "Confirm it's you". The page follows the checkout the way the
 * weekly-fee page follows one branch's (open, confirming, paid, not paid, expired, held), in the same words. Owner
 * only: a manager or staff member is never offered it (the link is the owner's; here they are told so and nothing is
 * asked of the server, which refuses them anyway).
 */
export default function PayAllBranchesPage() {
  const storeId = useStoreId();
  const queryClient = useQueryClient();
  const role = useStoreRole();
  const isOwner = role.role === 'OWNER';
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link href="/dashboard/weekly-fee" className="text-sm text-[var(--swift-muted)] hover:underline">← Weekly fee</Link>
        <h1 className="mt-1 text-2xl font-extrabold">{CHAIN_COPY.title}</h1>
      </div>
      {!role.known && !role.failed && <div className="sw-empty" role="status">Loading…</div>}
      {role.failed && <DataUnavailable what="your store details" onRetry={() => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'my-role') })} />}
      {role.known && !isOwner && <div className="sw-card p-6 text-sm">{CHAIN_COPY.ownerOnly}</div>}
      {isOwner && <PayAll key={storeId ?? 'no-store'} storeId={storeId} />}
    </div>
  );
}

function PayAll({ storeId }: { storeId: string | null }) {
  const client = useQueryClient();
  const queryKey = useMemo(() => storeKey(storeId, 'chain-fees'), [storeId]);
  const path = `/api/v1${CHAIN_FEE_PATH}`;
  const q = useQuery<ChainFees>({ queryKey, queryFn: () => apiFetch(path, undefined, { storeId }).then((r) => r.data), staleTime: 0, refetchInterval: 60_000 });
  const { withStepUp, dialog } = useStepUp();
  // [SPEED 30 Oct] Opened again: the branches' last known fees at once, said to be checking (no paying on them) until Swift answers.
  const checkingLatest = useCheckingLatest(q);
  const [view, setView] = useState<ChainView>({ checkout: null, busy: false, returned: false, error: '', blocked: false });
  const session = useMemo(() => new ChainCheckoutSession({
    // One MMG page for several fees: the server asks for a fresh "Confirm it's you" first (403 STEP_UP_REQUIRED).
    start: (key, confirmed) => withStepUp(() => apiFetch(`${path}/mmg-checkout`, { method: 'POST', body: JSON.stringify(confirmed), headers: { 'Idempotency-Key': key } }, { storeId }).then((r) => r.data))(),
    read: (ref) => apiFetch(`${path}/mmg-checkout/${encodeURIComponent(ref)}`, undefined, { storeId }).then((r) => r.data),
    open: async (url) => { window.location.assign(url); },
    refresh: () => { void client.invalidateQueries({ queryKey }); },
  }, () => crypto.randomUUID(), setView, (e) => (isStepUpDismissed(e) ? { dismissed: true } : e instanceof ApiRequestError ? e : {})), [client, path, queryKey, storeId, withStepUp]);
  useEffect(() => { session.activate(); return () => session.dispose(); }, [session]);
  const latest = q.data?.recentCheckouts?.[0];
  useEffect(() => { session.focus(latest); }, [session, latest?.ref]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { session.reconcile(q.data?.recentCheckouts); }, [session, q.data?.recentCheckouts]);
  useEffect(() => {
    const focus = () => { void client.invalidateQueries({ queryKey }); session.focus(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [client, queryKey, session]);

  if (q.isLoading) return <p>Loading your branches…</p>;
  if (q.isError || !q.data) return <DataUnavailable what="your branches' weekly fees" error={q.error} onRetry={() => void q.refetch()} />;
  const fees = q.data;
  const due = dueBranches(fees);
  const confirmed = chainConfirmed(fees);
  const checkout = view.returned ? view.checkout : view.checkout ?? latest ?? null;
  const pending = view.blocked || chainUnsettled(checkout);
  return (
    <section className="space-y-6">
      <div className="space-y-2 rounded-2xl border border-black/5 bg-white p-6 shadow-sm text-sm">
        <p className="text-base font-semibold">{CHAIN_COPY.intro}</p>
        <p>{CHAIN_COPY.optional}</p>
        <p className="text-[var(--swift-muted)]">{CHAIN_COPY.notCharged}</p>
        <CheckingLatest show={checkingLatest} />
      </div>
      <ul aria-label="Your branches" className="divide-y divide-black/5 rounded-2xl border border-black/5 bg-white shadow-sm">
        {fees.branches.map((b) => (
          <li key={b.vendorId} className="flex flex-wrap items-baseline justify-between gap-2 px-6 py-4">
            <span className="font-semibold">{b.branchName}</span>
            <span className={b.state === 'DUE' ? 'font-bold' : 'text-sm text-[var(--swift-muted)]'}>{chainBranchWords(b)}</span>
          </li>
        ))}
      </ul>
      <div className="space-y-3 rounded-2xl border border-black/5 bg-white p-6 shadow-sm">
        {due.length > 0
          ? <p className="text-2xl font-extrabold" data-testid="pay-all-total">{`Total due: ${feeMoney(fees.totalGyd)} for ${branchCount(due.length)}`}</p>
          : <p className="font-semibold">{CHAIN_COPY.nothingDue}</p>}
        {checkout && <p role="status">{chainCheckoutWords(checkout, view.returned)}</p>}
        {view.returned && !checkout && <p role="status">Waiting for MMG…</p>}
        {checkout && chainUnsettled(checkout) && <p className="text-sm text-[var(--swift-muted)]">{CHAIN_COPY.paused}</p>}
        {view.error && <p role="alert">{view.error}</p>}
        {due.length > 0 && !fees.payable && <p className="text-sm text-[var(--swift-muted)]">{CHAIN_COPY.notHere}</p>}
        {confirmed && !pending && <>
          <p className="text-sm text-[var(--swift-muted)]">Opens MMG&apos;s page, then brings you back to Swift. {CHAIN_COPY.confirmFirst}</p>
          <button disabled={view.busy || checkingLatest} onClick={() => void session.pay(confirmed)} className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[var(--swift-red)] px-6 py-3 font-bold text-white disabled:opacity-50">
            {view.busy ? 'Opening MMG…' : `Pay ${feeMoney(confirmed.totalGyd)} with MMG`}
          </button>
        </>}
      </div>
      <h2 className="text-lg font-bold">{CHAIN_COPY.recent}</h2>
      {fees.recentCheckouts?.length ? fees.recentCheckouts.map((c) => {
        const shown = c.ref === view.checkout?.ref ? view.checkout : c;
        return <div key={c.ref} className="space-y-2 rounded-2xl border border-black/5 bg-white p-5">
          <p className="text-sm text-[var(--swift-muted)]">{feeDate(c.createdAt)} · {feeMoney(c.amountGyd)} · {branchCount(shown.branches?.length ?? 0)}</p>
          <p>{chainCheckoutWords(shown, c.ref === view.checkout?.ref && view.returned)}</p>
          {chainShares(shown).map((line, i) => <p key={i} className="text-sm">{line}</p>)}
          {/* The references support finds this payment by: ours always, MMG's once confirmed. */}
          {chainCheckoutReferences(shown).map((r) => <p key={r.label} className="text-sm text-[var(--swift-muted)]">{r.label}: <span className="font-mono">{r.value}</span></p>)}
        </div>;
      }) : <p className="text-sm text-[var(--swift-muted)]">{CHAIN_COPY.noRecent}</p>}
      {dialog}
    </section>
  );
}
