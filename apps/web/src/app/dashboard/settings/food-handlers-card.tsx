'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFoodHandlers, tickFoodHandlers } from '@/lib/food-handlers-api';
import { storeKey } from '@/lib/store-scope';

/**
 * [FOOD-PERMIT · owner ruling 24 Oct 2026] A registered restaurant's owner ticks, for the selected store, the server's
 * words: "Everyone who handles food here holds a current food handler's certificate." It goes live on that tick (the
 * certificate itself is optional there). The website carries it so an owner on an older phone app can give it today.
 * The server sends the words, their version and which of the owner's stores it applies to, and decides everything
 * (who may tick, going live): a manager, a store it does not name, or a server without the words shows no card.
 */
export function FoodHandlersCard({ storeId, isOwner, vendorType }: { storeId: string | null; isOwner: boolean; vendorType?: string }) {
  const queryClient = useQueryClient();
  const [ticked, setTicked] = useState(false);
  const view = useQuery({ queryKey: storeKey(storeId, 'food-handlers'), queryFn: getFoodHandlers, enabled: isOwner && (vendorType === undefined || vendorType === 'RESTAURANT') });
  const save = useMutation({
    mutationFn: (version: string) => tickFoodHandlers(version),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'food-handlers') }),
  });

  const words = view.data;
  const store = words?.stores?.find((s) => s.vendorId === storeId);
  if (!isOwner || (vendorType !== undefined && vendorType !== 'RESTAURANT') || !words || typeof words.tick !== 'string' || !words.tick || typeof words.version !== 'string' || !store) return null;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold">Your food handlers</h2>
      {store.attested ? (
        <p className="mt-1 text-sm text-[var(--swift-muted)]">You confirmed: &ldquo;{words.tick}&rdquo;</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-[var(--swift-muted)]">
            Instead of uploading a certificate, confirm it for the people who handle food at {store.name}. You can still
            add your own food handler&apos;s certificate under{' '}
            <Link href="/dashboard/documents" className="font-semibold text-[var(--swift-red)]">Documents</Link> — customers see it on your store page.
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} className="mt-0.5" />
            <span>{words.tick}</span>
          </label>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => save.mutate(words.version)}
              disabled={!ticked || save.isPending}
              className="rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {save.isPending ? 'Saving…' : 'Confirm'}
            </button>
          </div>
          {save.isError && (
            <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">{(save.error as Error).message}</p>
          )}
        </>
      )}
    </div>
  );
}
