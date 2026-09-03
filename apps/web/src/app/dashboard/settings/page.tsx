'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmSettlement, getCashSettlements, getHours, getProfile, getSubscription, money, putHours } from '@/lib/vendor-api';
import { MutationNotice } from '@/components/mutation-notice';
import { setDraftDirty, storeKey, useStoreId } from '@/lib/store-scope';

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
    onSuccess: () => {
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
        <div className="rounded-2xl border border-black/5 bg-white p-6">
          <p role="alert" className="text-sm font-semibold text-[var(--swift-red)]">
            Couldn&apos;t load your hours: {(hours.error as Error).message}
          </p>
          <button onClick={() => hours.refetch()} className="mt-3 rounded-lg border border-black/10 px-3 py-1.5 text-sm font-semibold">
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
    setRows(rows.map((r) => (r.dayOfWeek === d ? { ...r, ...patch } : r)));
  };

  return (
    <div className="rounded-2xl border border-black/5 bg-white p-6">
      <h2 className="font-bold">Operating hours</h2>
      <div className="mt-4 space-y-2">
        {rows.map((r) => (
          <div key={r.dayOfWeek} className="flex items-center gap-3 text-sm">
            <span className="w-24 font-medium">{DAYS[r.dayOfWeek]}</span>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={!r.isClosed}
                onChange={(e) => set(r.dayOfWeek, { isClosed: !e.target.checked })}
                className="h-4 w-4 accent-[var(--swift-red)]"
              />
              Open
            </label>
            {!r.isClosed && (
              <>
                <input
                  type="time"
                  value={r.openTime}
                  onChange={(e) => set(r.dayOfWeek, { openTime: e.target.value })}
                  className="rounded-lg border border-black/10 px-2 py-1"
                />
                <span className="text-[var(--swift-muted)]">to</span>
                <input
                  type="time"
                  value={r.closeTime}
                  onChange={(e) => set(r.dayOfWeek, { closeTime: e.target.value })}
                  className="rounded-lg border border-black/10 px-2 py-1"
                />
              </>
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
        {error && <span className="text-sm text-[var(--swift-red)]">{error}</span>}
      </div>
    </div>
  );
}

function SubscriptionCard() {
  const storeId = useStoreId();
  const sub = useQuery({ queryKey: storeKey(storeId, 'subscription'), queryFn: getSubscription });
  const s = sub.data;
  if (sub.isLoading) return null;
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-6">
      <h2 className="font-bold">Subscription</h2>
      {!s ? (
        <p className="mt-2 text-sm text-[var(--swift-muted)]">No subscription on this store yet — it starts when your documents are verified.</p>
      ) : (
        <div className="mt-3 space-y-1 text-sm">
          <p>
            Status:{' '}
            <b className={s.status === 'ACTIVE' || s.status === 'TRIAL' ? 'text-green-600' : 'text-[var(--swift-red)]'}>
              {s.status}
            </b>
            {s.status === 'TRIAL' && s.trialEndsAt && (
              <span className="text-[var(--swift-muted)]"> — free until {new Date(s.trialEndsAt).toLocaleDateString()}</span>
            )}
          </p>
          <p>Weekly fee: <b>{money(s.weeklyRate)}</b> — you keep 100% of every sale.</p>
          {s.currentPeriodEnd && <p>Paid through: {new Date(s.currentPeriodEnd).toLocaleDateString()}</p>}
          <p className="text-[var(--swift-muted)]">
            Billing method: {s.billingMethod === 'MOBILE_MONEY' ? 'MMG (auto-charge)' : 'Cash / prepaid balance'} — change it in the Swift app.
          </p>
        </div>
      )}
    </div>
  );
}

function SettlementsCard() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const data = useQuery({ queryKey: storeKey(storeId, 'cash-settlements'), queryFn: getCashSettlements, refetchInterval: 60_000 });
  const confirm = useMutation({
    mutationFn: confirmSettlement,
    onSettled: () => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'cash-settlements') }),
  });
  const d = data.data;
  if (!d) return null;
  const rows: Array<Record<string, unknown>> = d.unsettled ?? [];
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-6">
      <h2 className="font-bold">Rider fees owed (MMG orders)</h2>
      <MutationNotice errors={[confirm.error]} className="mt-2" />
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        When a customer pays your MMG, the delivery fee lands in your wallet — hand the rider their fee in cash and
        confirm here. Both sides confirm; then it{'’'}s settled.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm font-medium text-green-600">Nothing owed — all settled ✓</p>
      ) : (
        <>
          <p className="mt-3 text-sm font-bold text-[var(--swift-red)]">
            {/* No `?? 0`: an absent server total must read as an em-dash, not as
                "nothing is owed" — a real zero and an invented zero mean
                opposite things to the person handing over cash. */}
            Owed now: {money(d.summary?.owed)} across {d.summary?.count ?? rows.length} deliveries
          </p>
          <div className="mt-2 space-y-2">
            {rows.map((r) => {
              const id = String(r['id']);
              const riderUser = (r['rider'] as { user?: { firstName?: string; lastName?: string } } | null)?.user;
              const rider = [riderUser?.firstName, riderUser?.lastName].filter(Boolean).join(' ') || 'Rider';
              const orderNo = (r['order'] as { orderNumber?: string } | null)?.orderNumber;
              const status = String(r['status']);
              return (
                <div key={id} className="flex items-center justify-between gap-3 rounded-lg bg-[var(--swift-subtle)] p-3 text-sm">
                  <span>
                    #{orderNo} · {rider} · <b>{money(r['amount'])}</b>
                    {status === 'RIDER_CONFIRMED' && <span className="ml-2 text-xs text-green-600">rider confirmed</span>}
                    {status === 'STORE_CONFIRMED' && <span className="ml-2 text-xs text-amber-600">waiting on rider</span>}
                  </span>
                  {status !== 'STORE_CONFIRMED' && (
                    <button
                      onClick={() => confirm.mutate(id)}
                      disabled={confirm.isPending}
                      className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                    >
                      Fee handed over
                    </button>
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
  const p = profile.data;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-extrabold">Settings</h1>

      {p && (
        <div className="rounded-2xl border border-black/5 bg-white p-6">
          <h2 className="font-bold">{p.name}</h2>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            {p.vendorType === 'SUPERMARKET' ? 'Grocery' : p.vendorType === 'STORE' ? 'Shop' : p.vendorType === 'SERVICE' ? 'Services' : 'Restaurant'}
            {p.city ? ` · ${p.city}` : ''} {p.isVerified ? ' · Verified ✓' : ' · Verification pending'}
          </p>
          {p.description && <p className="mt-2 text-sm">{p.description}</p>}
          <p className="mt-3 text-xs text-[var(--swift-muted)]">
            Name, description, photos, address and MMG details are edited in the Swift app (they go through review).
          </p>
        </div>
      )}

      <SubscriptionCard />
      <SettlementsCard />
      <HoursEditor />
    </div>
  );
}
