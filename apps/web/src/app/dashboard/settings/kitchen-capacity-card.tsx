'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getProfile, updateProfile } from '@/lib/vendor-api';
import { storeKey } from '@/lib/store-scope';

/** The most the web card offers; the server takes up to 1000. */
export const KITCHEN_CAPACITY_MAX = 100;

type ProfileStores = { vendors?: Array<{ id: string; vendorType?: string; maxConcurrentOrders?: unknown }>; myRole?: string };

/** The stored cap, null = no limit (every store's default). */
export function storedKitchenCapacity(store: unknown): number | null {
  const v = store && typeof store === 'object' ? (store as { maxConcurrentOrders?: unknown }).maxConcurrentOrders : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : null;
}

/**
 * [RIDER-SAFE 4 · FUL-007] "How many orders at once": a store can cap how many
 * orders it holds in the kitchen (new, accepted, cooking or ready) so it is
 * never drowned; past the cap customers are told the store is at capacity and
 * to try again in a few minutes. No limit by default. Owners and managers, for
 * stores that cook or pack (not Services, which has its own bookings setting).
 */
export function KitchenCapacityCard({ storeId }: { storeId: string | null }) {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: storeKey(storeId, 'profile'), queryFn: getProfile });
  const data = profile.data as ProfileStores | undefined;
  const store = data?.vendors?.find((v) => v.id === storeId) ?? (data?.vendors?.length === 1 ? data.vendors[0] : undefined);
  const manager = data?.myRole === 'OWNER' || data?.myRole === 'MANAGER';
  const value = storedKitchenCapacity(store);
  const [count, setCount] = useState<number | null>(value);
  useEffect(() => { setCount(value); }, [value]);

  const save = useMutation({
    mutationFn: (maxConcurrentOrders: number | null) => updateProfile({ maxConcurrentOrders }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'profile') }),
  });

  if (!manager || !store || store.vendorType === 'SERVICE') return null;
  const dirty = count !== value;
  return (
    <div className="sw-card p-6">
      <h2 className="font-bold" id="kitchen-capacity-title">How many orders at once</h2>
      <p className="mt-1 text-sm text-[var(--swift-muted)]">
        {count == null
          ? 'No limit. Set one if too many orders at once would make every order late: customers are asked to try again in a few minutes.'
          : `Up to ${count} orders at a time (new, cooking or ready). More wait until one is collected.`}
      </p>
      <div className="mt-3 flex items-center gap-3" role="group" aria-labelledby="kitchen-capacity-title">
        <button type="button" className="sw-chip" disabled={count == null || save.isPending} onClick={() => { save.reset(); setCount((c) => (c == null || c <= 1 ? null : c - 1)); }}>Fewer</button>
        <span className="min-w-16 text-center text-lg font-bold" aria-live="polite">{count == null ? 'No limit' : count}</span>
        <button type="button" className="sw-chip" disabled={(count ?? 0) >= KITCHEN_CAPACITY_MAX || save.isPending} onClick={() => { save.reset(); setCount((c) => (c == null ? 10 : Math.min(KITCHEN_CAPACITY_MAX, c + 1))); }}>{count == null ? 'Set a limit' : 'More'}</button>
        {count != null ? <button type="button" className="sw-chip" disabled={save.isPending} onClick={() => { save.reset(); setCount(null); }}>No limit</button> : null}
      </div>
      {save.isError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--swift-red)]">
          {save.error instanceof Error && save.error.message ? save.error.message : 'That could not be saved. Check your connection and try again.'}
        </p>
      ) : null}
      {dirty ? (
        <button type="button" onClick={() => save.mutate(count)} disabled={save.isPending}
          className="mt-3 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      ) : null}
    </div>
  );
}
