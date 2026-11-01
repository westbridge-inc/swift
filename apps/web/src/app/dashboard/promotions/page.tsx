'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { money } from '@/lib/vendor-api';
import { createPromo, deletePromo, getPromos, setPromoActive, type Promo } from '@/lib/store-extras-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { Modal } from '@/components/modal';

/** The phone's words (VendorAccountScreen PromosSection; the test reads them there). */
export const PROMO_WORDS = {
  none: 'No codes yet — run your first promotion and it shows on your storefront.',
  staff: 'Promotions are run by the store’s manager and owner.',
} as const;

const DAYS = [3, 7, 14, 30] as const;
const input = 'mt-1 w-full rounded-lg border border-[var(--swift-border)] bg-[var(--swift-card)] px-3 py-2 text-sm font-normal';

function terms(p: Promo): string {
  const off = p.discountType === 'PERCENTAGE' ? `${Number(p.discountValue)}% off` : `${money(p.discountValue)} off`;
  const min = p.minOrderAmount && Number(p.minOrderAmount) > 0 ? ` over ${money(p.minOrderAmount)}` : '';
  return `${off}${min} · used ${p.currentUses}×`;
}

/**
 * [WEB-SETTINGS PR-B · owner 31 Oct 2026] The store's own promo codes on the website: the phone's Account > Promotions
 * (PromosSection), with the same calls (GET/POST/PUT/DELETE /vendor/promos), form, Pause/Resume and asked-first delete,
 * in its words. Managers and owners only (the server's rule); the store funds its own codes, and the server checks
 * every term (a percentage up to 100, an end date in the future, a code nobody else uses).
 */
export default function PromotionsPage() {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const { manager, known } = useStoreRole();
  const promos = useQuery({ queryKey: storeKey(storeId, 'promos'), queryFn: getPromos, enabled: manager });
  const refresh = () => queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'promos') });

  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<'PERCENTAGE' | 'FIXED_AMOUNT'>('PERCENTAGE');
  const [value, setValue] = useState('');
  const [minOrder, setMinOrder] = useState('');
  const [days, setDays] = useState<number>(7);
  const [removing, setRemoving] = useState<Promo | null>(null);

  const create = useMutation({
    mutationFn: () => createPromo({
      code: code.trim().toUpperCase(),
      description: desc.trim(),
      discountType: kind,
      discountValue: Number(value),
      ...(Number(minOrder) > 0 ? { minOrderAmount: Number(minOrder) } : {}),
      validUntil: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
    }),
    onSuccess: () => {
      setShowForm(false);
      setCode('');
      setDesc('');
      setValue('');
      setMinOrder('');
      void refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (p: Promo) => setPromoActive(p.id, !p.isActive), onSettled: () => { void refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => deletePromo(id), onSettled: () => { void refresh(); } });

  if (known && !manager) return <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">{PROMO_WORDS.staff}</p>;

  const v = Number(value);
  const missing = !code.trim() ? 'Enter a code' : !desc.trim() ? 'Describe it for customers' : !(Number.isFinite(v) && v > 0) ? 'Set the discount' : null;
  const list = promos.data ?? [];

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/dashboard/settings" className="text-sm font-semibold text-[var(--swift-muted)] hover:underline">Back to settings</Link>
        <h1 className="sw-title mt-2">Promotions</h1>
        <p className="sw-caption mt-1">Codes your store funds. Customers enter a code at checkout in the Swift app.</p>
      </div>

      {promos.isError ? (
        <DataUnavailable what="your promo codes" error={promos.error} onRetry={() => void promos.refetch()} />
      ) : (
        <div className="sw-card p-6">
          {promos.isPending ? (
            <p role="status" className="text-sm text-[var(--swift-muted)]">Checking your promo codes…</p>
          ) : list.length === 0 ? (
            <p className="text-sm text-[var(--swift-muted)]">{PROMO_WORDS.none}</p>
          ) : (
            <ul className="space-y-3">
              {list.map((p) => {
                const expired = new Date(p.validUntil).getTime() < Date.now();
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 border-b border-[var(--swift-border)] pb-3 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <b className="tracking-wider">{p.code}</b>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${!expired && p.isActive ? 'bg-green-100 text-green-700' : 'bg-[var(--swift-subtle)] text-[var(--swift-muted)]'}`}>
                          {expired ? 'Expired' : p.isActive ? 'Live' : 'Paused'}
                        </span>
                      </p>
                      <p className="mt-1 break-words text-xs text-[var(--swift-muted)]">{terms(p)}</p>
                    </div>
                    {!expired && (
                      <button type="button" className="sw-chip min-h-11" disabled={toggle.isPending} onClick={() => { if (!toggle.isPending) toggle.mutate(p); }}>
                        {p.isActive ? 'Pause' : 'Resume'}
                      </button>
                    )}
                    <button type="button" className="sw-chip min-h-11" aria-label={`Delete promo ${p.code}`} disabled={remove.isPending} onClick={() => setRemoving(p)}>
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {(toggle.error || remove.error) && (
            <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{((toggle.error || remove.error) as Error).message}</p>
          )}

          {showForm ? (
            <div className="mt-4 space-y-3">
              <label className="block text-sm font-semibold">Code
                <input className={`${input} uppercase`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="SAVE20" maxLength={24} />
              </label>
              <label className="block text-sm font-semibold">What customers see
                <input className={input} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="20% off this week" maxLength={200} />
              </label>
              <fieldset className="flex flex-wrap gap-3 text-sm">
                <legend className="mb-1 text-sm font-semibold">Discount</legend>
                {([['PERCENTAGE', '% off'], ['FIXED_AMOUNT', 'GYD off']] as const).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1.5">
                    <input type="radio" name="promo-kind" checked={kind === k} onChange={() => setKind(k)} className="accent-[var(--swift-red)]" />
                    {label}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm font-semibold">{kind === 'PERCENTAGE' ? 'Discount (%)' : 'Discount (GYD)'}
                  <input className={input} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'PERCENTAGE' ? '20' : '500'} />
                </label>
                <label className="block text-sm font-semibold">Minimum order (optional)
                  <input className={input} inputMode="numeric" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} />
                </label>
              </div>
              <fieldset className="flex flex-wrap gap-3 text-sm">
                <legend className="mb-1 text-sm font-semibold">Runs for</legend>
                {DAYS.map((d) => (
                  <label key={d} className="flex items-center gap-1.5">
                    <input type="radio" name="promo-days" checked={days === d} onChange={() => setDays(d)} className="accent-[var(--swift-red)]" />
                    {d} days
                  </label>
                ))}
              </fieldset>
              {create.error && <p role="alert" className="text-sm text-[var(--swift-red)]">{(create.error as Error).message}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!!missing || create.isPending}
                  onClick={() => { if (!missing && !create.isPending) create.mutate(); }}
                  className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {create.isPending ? 'Launching…' : missing ?? 'Launch promotion'}
                </button>
                <button type="button" className="px-2 text-sm font-semibold text-[var(--swift-muted)]" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="sw-chip mt-4" onClick={() => setShowForm(true)}>New promotion</button>
          )}
        </div>
      )}

      {removing && (
        <Modal labelledBy="promo-delete-title" onClose={() => setRemoving(null)} className="sw-card mx-4 flex w-full max-w-sm flex-col gap-3 p-6">
          <h2 id="promo-delete-title" className="text-lg font-bold">Delete “{removing.code}”?</h2>
          <p className="text-sm text-[var(--swift-muted)]">
            {removing.currentUses > 0
              ? `Customers used it ${removing.currentUses}× — it disappears from your storefront immediately.`
              : 'It disappears from your storefront immediately.'}
          </p>
          <button
            type="button"
            className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={remove.isPending}
            onClick={() => { const id = removing.id; setRemoving(null); if (!remove.isPending) remove.mutate(id); }}
          >
            Delete promo
          </button>
          <button type="button" data-modal-initial-focus className="sw-chip justify-center" onClick={() => setRemoving(null)}>Keep it</button>
        </Modal>
      )}
    </div>
  );
}
