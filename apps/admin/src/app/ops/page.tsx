'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { fetchLiveOps } from '@/lib/api';
import { statusClass } from '@/lib/status';

// Leaflet touches `window` — client-only.
const OpsMap = dynamic(() => import('@/components/ops/OpsMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#1C1C1E] animate-pulse" />,
});

const LEGEND = [
  { color: '#34C759', label: 'Rider · available' },
  { color: '#FF9F0A', label: 'Rider · on a job' },
  { color: '#0A84FF', label: 'Driver · available' },
  { color: '#BF5AF2', label: 'Driver · on a trip' },
  { color: '#8E8E93', label: 'Order pickup' },
];

export default function OpsPage() {
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['live-ops'],
    queryFn: fetchLiveOps,
    refetchInterval: 15_000,
  });

  const ops = data?.data;
  const online = ops?.movers.length ?? 0;
  const busy = ops?.movers.filter((m) => m.busy).length ?? 0;
  const inFlight = ops?.activeOrders.length ?? 0;

  return (
    <div className="flex flex-col h-full -m-6">
      <div className="flex items-center gap-6 px-6 py-3 border-b border-[#38383A] bg-[#1C1C1E]">
        <h1 className="text-lg font-bold">Live ops</h1>
        <span className="text-sm text-[#8E8E93]">
          <span className="text-white font-semibold">{isLoading ? '—' : online}</span> movers online
        </span>
        <span className="text-sm text-[#8E8E93]">
          <span className="text-white font-semibold">{isLoading ? '—' : busy}</span> on jobs
        </span>
        <span className="text-sm text-[#8E8E93]">
          <span className="text-white font-semibold">{isLoading ? '—' : inFlight}</span> orders in flight
        </span>
        <span className="text-xs text-[#8E8E93] ml-auto">
          refreshes every 15s{dataUpdatedAt ? ` · updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative">
          <OpsMap data={ops} />
          <div className="absolute bottom-4 left-4 z-[1000] rounded-lg bg-[#1C1C1E]/90 border border-[#38383A] p-3 space-y-1.5">
            {LEGEND.map((l) => (
              <div key={l.label} className="flex items-center gap-2 text-xs text-[#8E8E93]">
                <span className="w-3 h-3 rounded-full border border-white/60" style={{ background: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
        </div>

        <aside className="w-80 border-l border-[#38383A] bg-[#1C1C1E] overflow-y-auto">
          <p className="px-4 pt-4 pb-2 text-[10px] font-semibold tracking-widest text-[#8E8E93]">
            IN FLIGHT ({inFlight})
          </p>
          {(ops?.activeOrders ?? []).length === 0 ? (
            <p className="px-4 text-sm text-[#8E8E93]">Nothing moving right now.</p>
          ) : (
            <div className="px-2 pb-4 space-y-1">
              {ops!.activeOrders.map((o) => (
                <Link
                  key={o.id}
                  href={`/orders/${o.id}`}
                  className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors text-sm"
                >
                  <span className="font-mono text-xs">{o.orderNumber}</span>
                  <span className={`ml-auto px-2 py-0.5 rounded-full text-[10px] ${statusClass(o.status)}`}>
                    {o.status.replaceAll('_', ' ')}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
