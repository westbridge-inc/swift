'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { selectedProfileStore, storeCheckLabel, type ProfileData } from './store-check';
import { confirmSettlement, getCashSettlements, getHours, getProfile, getSubscription, money, putHours } from '@/lib/vendor-api';
import { MutationNotice } from '@/components/mutation-notice';
import { DataUnavailable } from '@/components/data-unavailable';
import { readSettlementLedger } from '@/lib/cash-settlement-view';
import { subscriptionInGoodStanding, subscriptionLine, subscriptionStatusWord } from '@/lib/partner-fee';
import { setDraftDirty, storeKey, useStoreId } from '@/lib/store-scope';
import { RefundRuleCard } from './refund-rule-card';
import { FoodHandlersCard } from './food-handlers-card';
import { StorePhotosCard } from './store-photos-card';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type DayRow = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };

/** Named so the switch confirmation can tell the operator WHAT is unsaved. */
const HOURS_DRAFT = 'Operating hours';

function HoursEditor() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const hours = useQuery({ queryKey: storeKey(storeId, 'hours'), queryFn: getHours });
  const [rows, setRows] = useState<DayRow[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => setDraftDirty(HOURS_DRAFT, false), []);

  useEffect(() => {
    if (hours.data && !rows) {
      const byDay = new Map((hours.data as DayRow[]).map((h) => [h.dayOfWeek, h]));
      setRows(DAYS.map((_, d) => byDay.get(d) ?? { dayOfWeek: d, openTime: '08:00', closeTime: '20:00', isClosed: true }));
    }
  }, [hours.data, rows]);

  const save = useMutation({
    mutationFn: () =>
      putHours(rows!.map((r) => (r.isClosed ? { dayOfWeek: r.dayOfWeek, isClosed: true } : { ...r, isClosed: false }))),
    onMutate: () => setError(null),
    onSuccess: () => {
      // [U50] A save that worked clears the last one's error.
      setError(null);
      setSaved(true);
      setDraftDirty(HOURS_DRAFT, false);
      setTimeout(() => setSaved(false), 2500);
      queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'hours') });
    },
    onError: (e) => setError((e as Error).message),
  });

  if (!rows) {
    // [VG-006] A failed read used to leave "Loading…" forever.
    if (hours.isError) {
      return (
        <div className="sw-card p-6">
          <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">
            Couldn&apos;t load your hours: {(hours.error as Error).message}
          </p>
          <button onClick={() => hours.refetch()} className="mt-3 rounded-lg border border-[var(--swift-border)] px-3 py-1.5 text-sm font-semibold">
            Retry
          </button>
        </div>
      );
    }
    return <p className="text-sm text-[var(--swift-muted)]">Loading…</p>;
  }

  // [W-04] Editing marks the draft dirty, so switching stores ASKS before it
  // discards the work. The remount does the discarding; the register makes the
  // discard the operator's decision rather than a surprise.
  const set = (d: number, patch: Partial<DayRow>) => {
    setDraftDirty(HOURS_DRAFT, true);
    setSaved(false);
    setRows(rows.map((r) => (r.dayOfWeek === d ? { ...r, ...patch } : r)));
  };

  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Operating hours</h2>
      <div className="mt-4 space-y-2">
        {rows.map((r) => (
          <div key={r.dayOfWeek} className="flex flex-wrap items-center gap-3 border-b border-[var(--swift-border)] py-3 text-sm last:border-0 sm:flex-nowrap sm:py-0">
            <span className="w-24 shrink-0 font-medium">{DAYS[r.dayOfWeek]}</span>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!r.isClosed}
                onChange={(e) => set(r.dayOfWeek, { isClosed: !e.target.checked })}
                aria-label={`Open on ${DAYS[r.dayOfWeek]}`}
                className="h-4 w-4 accent-[var(--swift-red)]"
              />
              Open
            </label>
            {!r.isClosed && (
              <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <input
                  type="time"
                  value={r.openTime}
                  onChange={(e) => set(r.dayOfWeek, { openTime: e.target.value })}
                  aria-label={`${DAYS[r.dayOfWeek]} opens at`}
                  className="rounded-lg border border-[var(--swift-border)] px-2 py-1"
                />
                <span className="text-[var(--swift-muted)]">to</span>
                <input
                  type="time"
                  value={r.closeTime}
                  onChange={(e) => set(r.dayOfWeek, { closeTime: e.target.value })}
                  aria-label={`${DAYS[r.dayOfWeek]} closes at`}
                  className="rounded-lg border border-[var(--swift-border)] px-2 py-1"
                />
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--swift-red-600)] disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save hours'}
        </button>
        {saved && <span className="text-sm font-medium text-green-600">Saved ✓</span>}
        {error && <span role="alert" className="text-sm text-[var(--swift-red)]">{error}</span>}
      </div>
    </div>
  );
}

/**
 * [UI-SWEEP U20 / U18 / U46] The phone shows this card to OWNERS only, and the
 * read is owner-only on the server: every manager used to be told "No
 * subscription on this store yet", and so was an owner whose read failed. The
 * fee shown is the rate actually charged, in the phone's words.
 */
function SubscriptionCard({ isOwner }: { isOwner: boolean }) {
  const storeId = useStoreId();
  const sub = useQuery({ queryKey: storeKey(storeId, 'subscription'), queryFn: getSubscription, enabled: isOwner });
  if (!isOwner) return null;
  if (sub.isError) return <DataUnavailable what="your subscription" error={sub.error} onRetry={() => void sub.refetch()} />;
  // isPending, not isLoading: a read paused offline has no data and is not "no subscription".
  if (sub.isPending) return <div role="status" className="sw-card p-6 text-sm text-[var(--swift-muted)]">Checking your subscription…</div>;
  const s = (sub.data ?? null) as Record<string, unknown> | null;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Subscription</h2>
      {!s ? (
        <p className="mt-2 text-sm text-[var(--swift-muted)]">No subscription on this store yet — it starts when your documents are verified.</p>
      ) : (
        <div className="mt-3 space-y-1 text-sm">
          <p>
            Status: <b className={subscriptionInGoodStanding(s) ? 'text-green-600' : 'text-[var(--swift-red)]'}>{subscriptionStatusWord(s)}</b>
          </p>
          <p>{subscriptionLine(s)} — you keep 100% of every sale.</p>
          <p className="text-[var(--swift-muted)]">
            <Link href="/dashboard/weekly-fee" className="font-semibold underline">Weekly fee — view and pay</Link>
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * [UI-SWEEP U03 / U19 / U47 / U66] "You owe riders", in the phone's words
 * (VendorInsightsScreen RiderFeesOwedCard, lib/riderFeesOwed markPaidPrompt).
 * U19: a failed read used to remove the card, which to a store is the absence of
 * a debt. U66: rows read fields the server never sends, so they said
 * "#undefined · Rider". U03: the armed confirmation did not wrap and was cut off
 * on a 360-390 px phone.
 */
function SettlementsCard() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const data = useQuery({ queryKey: storeKey(storeId, 'cash-settlements'), queryFn: getCashSettlements, refetchInterval: 60_000 });
  // [W-26] Closing this row settles a REAL cash debt. The store confirms a
  // named amount for a named rider, in a second deliberate step, and the server
  // refuses any figure that is not the one owed.
  const [pending, setPending] = useState<string | null>(null);
  const confirm = useMutation({
    mutationFn: ({ id, amount }: { id: string; amount: string | number }) => confirmSettlement(id, amount),
    onSettled: () => {
      setPending(null);
      queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'cash-settlements') });
    },
  });
  const ledger = readSettlementLedger(data, 'rider');
  if (ledger.state === 'unavailable') {
    return <DataUnavailable what="what you owe riders" error={data.error} onRetry={() => void data.refetch()} />;
  }
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">You owe riders</h2>
      <MutationNotice errors={[confirm.error]} className="mt-2" />
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        MMG orders — the delivery fee came to you with the customer&apos;s payment. Hand it to the rider in cash (usually at
        pickup), then mark it paid. Both sides confirm; then it{'’'}s settled.
      </p>
      {ledger.state === 'loading' ? (
        <p role="status" className="mt-3 text-sm text-[var(--swift-muted)]">Checking what you owe riders…</p>
      ) : ledger.state === 'empty' ? (
        <p className="mt-3 text-sm font-medium text-green-600">Nothing owed — all settled ✓</p>
      ) : (
        <>
          <p className="mt-3 text-sm font-bold text-[var(--swift-red)]">
            {/* An absent server total reads as an em-dash, never as "nothing is owed". */}
            Owed now: {money(ledger.owed)} across {ledger.count} deliveries
          </p>
          <div className="mt-2 space-y-2">
            {ledger.rows.map((r) => {
              const id = r.id;
              const rider = r.counterparty ?? 'this rider';
              return (
                <div key={id} className="flex flex-col gap-3 rounded-lg bg-[var(--swift-subtle)] p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 break-words">
                    {r.orderNumber ? `#${r.orderNumber} · ` : ''}{r.counterparty ?? 'Rider'} · <b>{money(r.amount)}</b>
                    {r.status === 'RIDER_CONFIRMED' && <span className="ml-2 text-xs text-green-600">The rider confirmed receiving it — mark it paid to close it out.</span>}
                  </span>
                  {r.status !== 'STORE_CONFIRMED' ? (
                    pending === id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold">Paid {money(r.amount)} to {rider}?</span>
                        <button
                          onClick={() => confirm.mutate({ id, amount: r.rawAmount })}
                          disabled={confirm.isPending}
                          className="min-h-11 rounded-lg bg-[var(--swift-red)] px-3 text-xs font-bold text-white disabled:opacity-50"
                        >
                          {confirm.isPending ? 'Confirming…' : `Yes, I paid ${money(r.amount)}`}
                        </button>
                        <button onClick={() => setPending(null)} className="min-h-11 px-2 text-xs font-semibold text-[var(--swift-muted)]">Not yet</button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setPending(id)}
                        disabled={confirm.isPending}
                        className="min-h-11 shrink-0 self-start rounded-lg border border-[var(--swift-red)] px-3 text-xs font-bold text-[var(--swift-red)] disabled:opacity-50 sm:self-auto"
                      >
                        Mark paid
                      </button>
                    )
                  ) : (
                    <span className="text-xs text-[var(--swift-muted)]">You marked this paid — waiting for the rider to confirm.</span>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const storeId = useStoreId();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const p = selectedProfileStore(profile.data as ProfileData | undefined, storeId);
  const isOwner = (profile.data as { myRole?: string } | undefined)?.myRole === 'OWNER';

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="sw-title">Settings</h1>

      {profile.isError && <DataUnavailable what="your store details" error={profile.error} onRetry={() => void profile.refetch()} />}
      {p && (
        <div className="sw-card p-6">
          <h2 className="font-bold">{p.name}</h2>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            {p.vendorType === 'SUPERMARKET' ? 'Grocery' : p.vendorType === 'STORE' ? 'Shop' : p.vendorType === 'SERVICE' ? 'Services' : 'Restaurant'}
            {p.city ? ` · ${p.city}` : ''} · {storeCheckLabel(p)}
          </p>
          {p.description && <p className="mt-2 text-sm">{p.description}</p>}
          <p className="mt-3 text-xs text-[var(--swift-muted)]">
            Name, description, address and MMG details are edited in the Swift app (they go through review).
          </p>
        </div>
      )}

      <StorePhotosCard storeId={storeId} />
      <RefundRuleCard storeId={storeId} />
      {/* [FOOD-PERMIT · owner 24 Oct 2026] a registered restaurant's owner ticks for its food handlers */}
      <FoodHandlersCard storeId={storeId} isOwner={isOwner} vendorType={p?.vendorType} />
      <SubscriptionCard isOwner={isOwner} />
      <SettlementsCard />
      <HoursEditor />
    </div>
  );
}
