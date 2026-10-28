'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchLiveOps } from '@/lib/api';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { gyTime } from '@/lib/dates';

// Leaflet touches `window` — client-only.
const OpsMap = dynamic(() => import('@/components/ops/OpsMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[var(--mc-surface)] animate-pulse" />,
});

const LEGEND = [
  { color: '#34C759', label: 'Rider · available' },
  { color: 'var(--warn)', label: 'Rider · on a job' },
  { color: 'var(--accent)', label: 'Driver · available' },
  { color: '#BF5AF2', label: 'Driver · on a trip' },
  { color: 'var(--muted)', label: 'Order pickup' },
];

export default function OpsPage() {
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['live-ops'],
    queryFn: fetchLiveOps,
    refetchInterval: 15_000,
  });

  // A failed poll never shows the last picture as live: no counts, no stale pins.
  const ops = isError ? undefined : data?.data;
  const unknown = isLoading || isError;
  const online = ops?.movers.length ?? 0;
  const busy = ops?.movers.filter((m) => m.busy).length ?? 0;
  const inFlight = ops?.activeOrders.length ?? 0;

  return (
    <div className="mc-page mc-page-flush flex flex-col">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-[var(--mc-line)] bg-[var(--mc-card)] px-4 py-3 md:px-6">
        <span className="mc-muted">
          <span className="mc-numbers font-semibold text-[var(--mc-ink)]">{unknown ? '—' : online}</span> movers online
        </span>
        <span className="mc-muted">
          <span className="mc-numbers font-semibold text-[var(--mc-ink)]">{unknown ? '—' : busy}</span> on jobs
        </span>
        <span className="mc-muted">
          <span className="mc-numbers font-semibold text-[var(--mc-ink)]">{unknown ? '—' : inFlight}</span> orders in flight
        </span>
        <span className="mc-muted ml-auto text-xs">
          Refreshes every 15 seconds{dataUpdatedAt && !isError ? ` · updated ${gyTime(dataUpdatedAt)}` : ''}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="relative min-h-[50vh] flex-1">
          <OpsMap data={ops} />
          <div className="absolute bottom-4 left-4 z-[1000] space-y-1.5 rounded-[var(--mc-radius-sm)] border border-[var(--mc-line)] bg-[var(--mc-card)] p-3 shadow-sm">
            {LEGEND.map((l) => (
              <div key={l.label} className="flex items-center gap-2 text-xs text-[var(--mc-muted-strong)]">
                <span className="h-3 w-3 rounded-full border border-[var(--mc-line-strong)]" style={{ background: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
        </div>

        <aside className="overflow-y-auto border-t border-[var(--mc-line)] bg-[var(--mc-card)] md:w-80 md:border-l md:border-t-0" aria-label="Orders in flight">
          <p className="mc-label px-4 pb-2 pt-4">
            In flight ({unknown ? '—' : inFlight})
          </p>
          {isLoading ? (
            <p className="mc-muted px-4">Loading…</p>
          ) : isError ? (
            <div className="px-4 pb-4">
              <QueryFailed error={error} what="live ops" onRetry={() => void refetch()} retrying={isFetching} />
            </div>
          ) : (ops?.activeOrders ?? []).length === 0 ? (
            <p className="mc-muted px-4 pb-4">Nothing moving right now.</p>
          ) : (
            <div className="space-y-1 px-2 pb-4">
              {ops!.activeOrders.map((o) => (
                <Link
                  key={o.id}
                  href={`/orders/${o.id}`}
                  className="flex min-h-[44px] items-center gap-2 rounded-[var(--mc-radius-sm)] px-2 py-2 hover:bg-[var(--mc-surface)]"
                >
                  <span className="mc-numbers font-semibold">{o.orderNumber}</span>
                  <span className="ml-auto"><StatusBadge group="OrderStatus" value={o.status} /></span>
                </Link>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
