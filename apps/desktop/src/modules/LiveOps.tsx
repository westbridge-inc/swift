import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchOpsLive, retryDispatch } from '../lib/api';

// Live Ops (spec §5.3) as the FEED: every active order grouped by lane,
// oldest (most stuck) first — the server already orders by placedAt asc.
// The geographic map lives in the admin console (Leaflet); the desktop feed
// is the triage surface. 10s poll — this is the closest thing to a firehose
// the API exposes today.

const LANES: Array<{ title: string; match: (s: string) => boolean }> = [
  { title: 'Waiting on a store', match: (s) => s === 'PENDING' },
  { title: 'In the kitchen', match: (s) => ['ACCEPTED', 'PREPARING'].includes(s) },
  {
    title: 'Waiting on a mover',
    match: (s) => ['READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'].includes(s),
  },
  { title: 'Moving', match: (s) => ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'].includes(s) },
  {
    title: 'Rides',
    match: (s) => ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS'].includes(s),
  },
];

export default function LiveOps() {
  const q = useQuery({ queryKey: ['ops-live'], queryFn: fetchOpsLive, refetchInterval: 10_000 });

  if (q.isLoading) return <p className="text-sm text-neutral-400">Loading live operations…</p>;
  if (q.isError) {
    return (
      <div className="rounded-2xl border border-neutral-200 bg-neutral-100 p-8 text-center">
        <p className="text-sm text-neutral-600">{(q.error as Error).message}</p>
        <button onClick={() => q.refetch()} className="mt-4 rounded-lg bg-[var(--swift-red)] px-4 py-2 text-sm font-semibold">Try again</button>
      </div>
    );
  }

  const movers: any[] = q.data?.movers ?? [];
  const orders: any[] = q.data?.activeOrders ?? [];
  const exhausted: any[] = q.data?.exhaustedSearches ?? [];
  const riders = movers.filter((m) => m.kind === 'rider');
  const drivers = movers.filter((m) => m.kind === 'driver');
  const busy = movers.filter((m) => m.busy).length;

  return (
    <div className="space-y-5">
      <div className="flex gap-4 text-sm text-neutral-600">
        <span><b className="text-neutral-900">{orders.length}</b> active orders</span>
        <span><b className="text-neutral-900">{riders.length}</b> riders online</span>
        <span><b className="text-neutral-900">{drivers.length}</b> taxis online</span>
        <span><b className="text-neutral-900">{busy}</b> busy</span>
        <span className="ml-auto text-xs text-neutral-400">10s refresh · map view lives in the admin console</span>
      </div>

      {/* Availability spec §6: exhausted searches float to the TOP in danger —
          every one is a customer whose search found nobody and nobody acted. */}
      {exhausted.length > 0 && (
        <div className="rounded-2xl border border-[var(--swift-red)]/50 bg-[var(--swift-red)]/10 p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-[var(--swift-red)]">
            Search exhausted · {exhausted.length}
          </p>
          <div className="mt-2 space-y-1.5">
            {exhausted.map((s) => (
              <ExhaustedRow key={s.id} search={s} onDone={() => q.refetch()} />
            ))}
          </div>
        </div>
      )}

      {orders.length === 0 && (
        <p className="rounded-2xl border border-dashed border-neutral-200 p-10 text-center text-sm text-neutral-400">
          No active orders right now.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
        {LANES.map((lane) => {
          const rows = orders.filter((o) => lane.match(String(o.status)));
          if (rows.length === 0) return null;
          return (
            <div key={lane.title} className="rounded-2xl border border-neutral-200 bg-neutral-100 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                {lane.title} · {rows.length}
              </p>
              <div className="mt-2 max-h-72 space-y-1.5 overflow-auto pr-1">
                {rows.map((o) => (
                  <div key={o.id} className="rounded-lg bg-black/30 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">#{o.orderNumber}</p>
                      <span className="text-[11px] text-neutral-400">{String(o.orderType).replaceAll('_', ' ')}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-neutral-500">{String(o.status).replaceAll('_', ' ')}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One exhausted search: what was tried, and the one-tap re-run (§6).
 *  No optimism — the row renders the server's answer or its error. */
function ExhaustedRow({ search, onDone }: { search: any; onDone: () => void }) {
  const rerun = useMutation({ mutationFn: () => retryDispatch(search.orderId), onSuccess: onDone });
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-black/30 px-3 py-2">
      <div>
        <p className="text-sm font-semibold">
          #{search.orderNumber ?? search.orderId}
          <span className="ml-2 text-[11px] text-neutral-400">{search.vertical}</span>
        </p>
        <p className="mt-0.5 text-xs text-neutral-500">
          {search.waves} wave{search.waves === 1 ? '' : 's'} · {search.candidatesTried} candidate
          {search.candidatesTried === 1 ? '' : 's'} tried · {search.vendorName ?? 'no vendor'}
        </p>
        {rerun.isError && <p className="mt-0.5 text-xs text-[var(--swift-red)]">{(rerun.error as Error).message}</p>}
      </div>
      <button
        onClick={() => rerun.mutate()}
        disabled={rerun.isPending}
        className="rounded-lg bg-[var(--swift-red)] px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
      >
        {rerun.isPending ? 'Re-running…' : 'Re-run search'}
      </button>
    </div>
  );
}
