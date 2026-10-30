'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStoreFee, tickStoreFee } from '@/lib/store-fee-api';
import { formatAmount } from '@/lib/money';
import { storeKey } from '@/lib/store-scope';

/**
 * [RETIER PR-A2 · owner 30 Oct 2026] A new store's weekly fee follows its own catalogue when Swift approves it. Above
 * the first step, the store goes live only after its owner reads that exact fee and ticks "I understand the weekly
 * fee" for it — here, or in the Swift app under Documents. The amount, why and the words are the server's; it records
 * the tick for exactly the amount shown (a changed amount is refused: the card shows the new one). Nothing is charged
 * before the tick. A manager, a store with its fee already set, or an answer without the words shows no card.
 */
export function StoreFeeCard({ storeId, isOwner }: { storeId: string | null; isOwner: boolean }) {
  const queryClient = useQueryClient();
  const [ticked, setTicked] = useState(false);
  const view = useQuery({ queryKey: storeKey(storeId, 'store-weekly-fee'), queryFn: getStoreFee, enabled: isOwner });
  const v = view.data;
  const fee = v?.weeklyFee;
  const terms = v?.terms;
  const save = useMutation({
    mutationFn: () => tickStoreFee({ version: fee!.version, amount: fee!.amount, currencyCode: fee!.currencyCode }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'store-weekly-fee') }),
  });
  if (!isOwner || !v || v.required !== true || v.ticked !== false || !fee || !(fee.amount > 0) || !terms || !terms.tick || terms.version !== fee.version) return null;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Your weekly fee: {formatAmount(fee.amount, `${fee.currencyCode} `)} a week</h2>
      {v.why && <p className="mt-1 text-sm text-[var(--swift-muted)]">{v.why}</p>}
      <ul className="mt-3 space-y-1 text-sm">
        {terms.items.map((item) => (
          <li key={item.heading}><b>{item.heading}:</b> {item.text}</li>
        ))}
      </ul>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5" />
        <span>{terms.tick}</span>
      </label>
      <div className="mt-3">
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!ticked || save.isPending}
          className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Confirm'}
        </button>
      </div>
      {save.isError && <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{(save.error as Error).message}</p>}
    </div>
  );
}
