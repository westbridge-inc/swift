'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getOverview, getStores, money, toggleOrders } from '@/lib/vendor-api';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { DataUnavailable } from './data-unavailable';
import { MutationNotice } from './mutation-notice';

/**
 * The store strip above the order board. Its name and open / taking-orders
 * state come from the stores list the console shell already reads (any role);
 * the overview's money and queue figures are manager-only on the server
 * (GET /vendor/analytics/overview requires MANAGER), so — as in the app's
 * VendorOps — only an owner or manager loads them and sees Pause / Resume.
 */
export function BusinessStatus() {
  const storeId = useStoreId();
  const client = useQueryClient();
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const list = Array.isArray(stores.data?.stores) ? stores.data.stores : [];
  const store = list.find((s) => s.id === storeId) ?? list.find((s) => s.id === stores.data?.selectedId);
  const canManage = stores.data?.myRole === 'OWNER' || stores.data?.myRole === 'MANAGER';
  const overview = useQuery({ queryKey: storeKey(storeId, 'overview'), queryFn: getOverview, refetchInterval: 30_000, enabled: canManage });
  const update = useMutation({
    mutationFn: toggleOrders,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: storeKey(storeId, 'overview') });
      void client.invalidateQueries({ queryKey: ['stores'] });
    },
  });
  if (stores.isLoading) return <div role="status" className="sw-skeleton h-28"><span className="sr-only">Loading store status…</span></div>;
  if (stores.isError || !store) return <DataUnavailable what="your store status" error={stores.error} onRetry={() => void stores.refetch()} />;
  // The overview is fresher (it polls); fall back to the stores read.
  const open = overview.data?.vendor?.isCurrentlyOpen ?? store.isCurrentlyOpen;
  const accepting = overview.data?.vendor?.acceptingOrders ?? store.acceptingOrders;
  return <section aria-label="Store status" className="sw-bleed space-y-4 bg-[var(--swift-sunken)] py-4">
    <div className="flex flex-wrap items-center gap-3"><div className="min-w-0 flex-1"><p className="sw-label">{store.name}</p><p className="sw-caption">{open ? (accepting ? 'Active — your store is open and taking orders.' : 'Orders paused.') : 'Your store is closed.'}</p></div>
      {canManage && <button type="button" disabled={update.isPending} onClick={() => update.mutate(!accepting)} className="sw-btn sw-btn-md sw-btn-outline">{accepting ? 'Pause orders' : 'Resume orders'}</button>}
    </div>
    <MutationNotice errors={[update.error]} />
    {canManage && overview.isError && <DataUnavailable what="today's figures" error={overview.error} onRetry={() => void overview.refetch()} />}
    <dl className="grid grid-cols-3 gap-3">
      {canManage && <div><dt className="sw-caption">Today</dt><dd className="sw-title mt-1">{overview.data ? money(overview.data.today?.revenue) : '—'}</dd></div>}
      {canManage && <div><dt className="sw-caption">Waiting</dt><dd className="sw-title mt-1">{overview.data?.pendingOrders ?? '—'}</dd></div>}
      <div><dt className="sw-caption">Swift takes</dt><dd className="sw-title mt-1">0%</dd></div>
    </dl>
  </section>;
}
