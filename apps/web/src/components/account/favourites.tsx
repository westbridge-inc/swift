'use client';

import { useState } from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Heart } from 'lucide-react';
import { useCustomerSession } from '@/components/customer-session';
import { DataUnavailable } from '@/components/data-unavailable';
import { signInPath } from '@/lib/customer-routes';
import { accountApi } from './account-api';
import { AccountFrame, useAccountQuery } from './account-frame';

export function FavouriteButton({ vendorId, name }: { vendorId: string; name: string }) {
  const session = useCustomerSession();
  return <FavouriteControl key={`${session.scope}:${session.epoch}`} vendorId={vendorId} name={name} />;
}

function FavouriteControl({ vendorId, name }: { vendorId: string; name: string }) {
  const session = useCustomerSession();
  const favourites = useAccountQuery('favourites', accountApi.favourites);
  const queryClient = useQueryClient();
  const mutationKey = ['account', session.scope, session.epoch, 'favourite', vendorId];
  const busy = useIsMutating({ mutationKey }) > 0;
  const [error, setError] = useState<string | null>(null);
  const saved = favourites.data?.some((vendor) => vendor.id === vendorId) ?? false;
  const mutation = useMutation({
    mutationKey,
    mutationFn: async (wasSaved: boolean) => { await accountApi.favourite(vendorId, wasSaved); await favourites.refetch(); },
    onError: (e: Error) => setError(e.message),
  });
  const className = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-[var(--swift-border)] bg-white px-3 text-[var(--swift-red)] disabled:opacity-50';
  if (session.status === 'guest') return <Link href={signInPath(`/order/vendor/${encodeURIComponent(vendorId)}`)} className={className} aria-label={`Sign in to save ${name}`}><Heart size={20} aria-hidden /></Link>;
  function toggle() {
    if (queryClient.isMutating({ mutationKey }) || !favourites.data || favourites.isError) return;
    setError(null); mutation.mutate(saved);
  }
  return <div>
    <button type="button" className={className} aria-label={`${saved ? 'Remove' : 'Save'} ${name}${saved ? ' from favourites' : ' to favourites'}`} aria-pressed={saved}
      disabled={busy || session.status !== 'signed-in' || !favourites.data || favourites.isError} onClick={() => void toggle()}>
      <Heart size={20} fill={saved ? 'currentColor' : 'none'} aria-hidden />
    </button>
    {favourites.isError && <button type="button" className="block text-xs underline" onClick={() => void favourites.refetch()}>Retry favourites</button>}
    {error && <p role="alert" className="text-sm">{error}</p>}
  </div>;
}

export function Favourites() {
  const favourites = useAccountQuery('favourites', accountApi.favourites);
  return <AccountFrame title="Favourites">
    <p className="text-sm text-[var(--swift-muted)]">Your saved stores, ready for next time.</p>
    {favourites.isError ? <DataUnavailable what="your favourites" error={favourites.error} onRetry={() => void favourites.refetch()} />
      : !favourites.data ? <p role="status">Loading favourites…</p>
      : favourites.data.length === 0 ? <p>No favourites yet. Save a store with its heart.</p>
      : <ul className="space-y-3">{favourites.data.map((vendor) => <li key={vendor.id} className="flex items-center justify-between gap-3 sw-card p-4">
        <Link href={`/order/vendor/${encodeURIComponent(vendor.id)}`} className="min-h-11 flex-1 py-3 font-bold">{vendor.name}</Link>
        <FavouriteButton vendorId={vendor.id} name={vendor.name} />
      </li>)}</ul>}
    <Link href="/order/search" className="inline-block py-3 font-semibold text-[var(--swift-red)]">Find a store</Link>
  </AccountFrame>;
}
