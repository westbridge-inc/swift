'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { useStoreRole } from '@/lib/store-role';
import { money } from '@/lib/vendor-api';
import { createPromo, deletePromo, getPromos, setPromoActive, type Promo } from '@/lib/store-extras-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { Modal } from '@/components/modal';
import { PROMO_WORDS, readAmount } from './promo-words';


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
  const { manager, known, failed } = useStoreRole();
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
  const [kept, setKept] = useState<string | null>(null);
  // [REVIEW-F #2281 S4-2] When the form or a row goes away, focus goes somewhere on purpose, never to the page's top.
  const [focusTo, setFocusTo] = useState<'new' | 'heading' | null>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusTo) return;
    (focusTo === 'new' ? newRef.current : headingRef.current)?.focus();
    setFocusTo(null);
  }, [focusTo]);

  const v = readAmount(value);
  const minimum = readAmount(minOrder);

  const create = useMutation({
    mutationFn: () => createPromo({
      code: code.trim().toUpperCase(),
      description: desc.trim(),
      discountType: kind,
      discountValue: v ?? 0,
      ...(minimum !== null && minimum > 0 ? { minOrderAmount: minimum } : {}),
      validUntil: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
    }),
    onSuccess: () => {
      setShowForm(false);
      setCode('');
      setDesc('');
      setValue('');
      setMinOrder('');
      setFocusTo('new');
      void refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (p: Promo) => setPromoActive(p.id, !p.isActive), onSettled: () => { void refresh(); } });
  const remove = useMutation({
    mutationFn: (id: string) => deletePromo(id),
    onMutate: () => setKept(null),
    // The server keeps a code customers used (paused, so its orders still read): the page says so instead of "deleted".
    onSuccess: (r: { data?: { deactivated?: unknown } } | undefined) => { if (r?.data?.deactivated === true) setKept(PROMO_WORDS.kept); },
    onSettled: () => { setFocusTo('heading'); void refresh(); },
  });

  if (known && !manager) return <p className="sw-card p-6 text-sm text-[var(--swift-muted)]">{PROMO_WORDS.staff}</p>;

  // [REVIEW-F #2281 S4-3] The server's own rules, checked first so its refusal is never just "Invalid request data".
  const typed = code.trim();
  const missing = !typed ? 'Enter a code'
    : typed.length < 3 ? PROMO_WORDS.codeShort
    : !/^[A-Za-z0-9-]+$/.test(typed) ? PROMO_WORDS.codeChars
    : !desc.trim() ? 'Describe it for customers'
    : !(v !== null && v > 0) ? 'Set the discount'
    : kind === 'PERCENTAGE' && v > 100 ? PROMO_WORDS.overHundred
    : minimum !== null && !(minimum >= 0) ? PROMO_WORDS.setMinimum
    : null;
  const list = promos.data ?? [];

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <Link href="/dashboard/settings" className="text-sm font-semibold text-[var(--swift-muted)] hover:underline">Back to settings</Link>
        <h1 ref={headingRef} tabIndex={-1} className="sw-title mt-2">Promotions</h1>
        <p className="sw-caption mt-1">Codes your store funds. Customers enter a code at checkout in the Swift app.</p>
      </div>

      {failed ? (
        // [REVIEW-F #2281 S4-1] The role could not be read: say so, never "Checking…" for ever.
        <DataUnavailable what="your store details" onRetry={() => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'my-role') })} />
      ) : promos.isError ? (
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
          {kept && <p role="status" className="mt-2 text-sm text-[var(--swift-muted)]">{kept}</p>}
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
                <button type="button" className="px-2 text-sm font-semibold text-[var(--swift-muted)]" onClick={() => { setShowForm(false); setFocusTo('new'); }}>Cancel</button>
              </div>
            </div>
          ) : known && manager ? (
            <button ref={newRef} type="button" className="sw-chip mt-4" onClick={() => setShowForm(true)}>New promotion</button>
          ) : null}
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
