'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getOverview, money, toggleOrders } from '@/lib/vendor-api';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { DataUnavailable } from './data-unavailable';
import { MutationNotice } from './mutation-notice';

export function BusinessStatus() {
  const store = useStoreId();
  const client = useQueryClient();
  const q = useQuery({ queryKey: storeKey(store, 'overview'), queryFn: getOverview, refetchInterval: 30_000 });
  const update = useMutation({ mutationFn: toggleOrders, onSettled: () => client.invalidateQueries({ queryKey: storeKey(store, 'overview') }) });
  if (q.isLoading) return <div role="status" className="sw-skeleton h-28"> <span className="sr-only">Loading store status…</span></div>;
  if (q.isError || !q.data?.vendor) return <DataUnavailable what="your store status" error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return <section aria-label="Store status" className="sw-bleed space-y-4 bg-[var(--swift-sunken)] py-4">
    <div className="flex flex-wrap items-center gap-3"><div className="flex-1"><p className="sw-label">{d.vendor.name}</p><p className="sw-caption">{d.vendor.isCurrentlyOpen ? (d.vendor.acceptingOrders ? 'Active — your store is open and taking orders.' : 'Orders paused.') : 'Your store is closed.'}</p></div>
      <button type="button" disabled={update.isPending} onClick={() => update.mutate(!d.vendor.acceptingOrders)} className="sw-btn sw-btn-md sw-btn-outline">{d.vendor.acceptingOrders ? 'Pause orders' : 'Resume orders'}</button>
    </div>
    <MutationNotice errors={[update.error]} />
    <dl className="grid grid-cols-3 gap-3"><div><dt className="sw-caption">Today</dt><dd className="sw-title mt-1">{money(d.today?.revenue)}</dd></div><div><dt className="sw-caption">Waiting</dt><dd className="sw-title mt-1">{d.pendingOrders ?? '—'}</dd></div><div><dt className="sw-caption">Swift takes</dt><dd className="sw-title mt-1">0%</dd></div></dl>
  </section>;
}
