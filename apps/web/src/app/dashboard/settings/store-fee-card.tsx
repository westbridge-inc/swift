'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStoreFee, storeFeeKey, tickStoreFee } from '@/lib/store-fee-api';
import { DataUnavailable } from '@/components/data-unavailable';
import { feeMoney } from '@/lib/fee-status';
import { storeKey } from '@/lib/store-scope';

/**
 * [RETIER PR-A2 · owner 30 Oct 2026] A new store's weekly fee follows its own catalogue when Swift approves it. Above
 * the first step, the store goes live only after its owner reads that exact fee and ticks "I understand the weekly
 * fee" for it — here, or in the Swift app under Documents. OWNER only, for the store named (read and ticked with that
 * store's id; an answer about another store shows nothing). The tick is given to the exact fee on screen: if another
 * amount, currency or version arrives, or the save fails, the box empties. The server records the tick only for its
 * own current quote. A read that failed (or an answer that says a tick is needed but cannot be read) shows that it
 * could not be loaded, with Try again, never nothing (REVIEW-F #2246 S3-1). Nothing is charged before the tick.
 */

/** The fee as every web fee screen writes it: GY$ for Guyana dollars, else the currency code (whole units). */
const money = (amount: number, currencyCode: string) => (currencyCode === 'GYD' ? feeMoney(amount) : `${currencyCode} ${amount.toLocaleString('en-US')}`);

export function StoreFeeCard({ storeId, isOwner }: { storeId: string | null; isOwner: boolean }) {
  const queryClient = useQueryClient();
  const [tickedKey, setTickedKey] = useState<string | null>(null);
  const enabled = isOwner && !!storeId;
  const view = useQuery({ queryKey: storeKey(storeId, 'store-weekly-fee'), queryFn: () => getStoreFee(storeId!), enabled });
  const v = view.data;
  const fee = v?.weeklyFee;
  const terms = v?.terms;
  const save = useMutation({
    mutationFn: (shown: { vendorId: string; weeklyFeeAck: { version: string; amount: number; currencyCode: string } }) => tickStoreFee(shown),
    onError: () => setTickedKey(null),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'store-weekly-fee') }),
  });
  if (!enabled) return null;
  if (view.isError) return <DataUnavailable what="your weekly fee" error={view.error} onRetry={() => void view.refetch()} />;
  if (!v || v.vendorId !== storeId) return null;
  if (v.required !== true || v.ticked !== false) {
    return save.isSuccess ? <p role="status" className="sw-card p-6 text-sm text-[var(--swift-muted)]">Saved. Your store goes live once Swift&apos;s other checks are done.</p> : null;
  }
  // A tick is needed but the answer cannot be read (or is not a whole fee): never a blank, the owner would be stuck.
  if (!fee || !Number.isInteger(fee.amount) || !(fee.amount > 0) || !terms || !terms.tick || terms.version !== fee.version || !Array.isArray(terms.items)) {
    return <DataUnavailable what="your weekly fee" onRetry={() => void view.refetch()} />;
  }
  const key = storeFeeKey(storeId!, fee);
  const checked = tickedKey === key;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Your weekly fee: {money(fee.amount, fee.currencyCode)} a week</h2>
      {v.why && <p className="mt-1 text-sm text-[var(--swift-muted)]">{v.why}</p>}
      <ul className="mt-3 space-y-1 text-sm">
        {terms.items.map((item) => (
          <li key={item.heading}><b>{item.heading}:</b> {item.text}</li>
        ))}
      </ul>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(e) => setTickedKey(e.target.checked ? key : null)} className="mt-0.5" />
        <span>{terms.tick}</span>
      </label>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => { if (checked) save.mutate({ vendorId: storeId!, weeklyFeeAck: { version: fee.version, amount: fee.amount, currencyCode: fee.currencyCode } }); }}
          disabled={!checked || save.isPending}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Confirm'}
        </button>
      </div>
      {save.isError && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{(save.error as Error).message}</p>}
    </div>
  );
}
