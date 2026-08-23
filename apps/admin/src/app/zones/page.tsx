'use client';

import { useQuery } from '@tanstack/react-query';
import { Map } from 'lucide-react';
import { fetchZones } from '@/lib/api';

/** [WR-046] This page claimed "No zones are configured today" while the zones
 *  CRUD exists and ACTIVE zones drive live taxi fares (fare.service.ts). It
 *  now shows the real zone list read-only; drawing/editing stays a roadmap
 *  item and says so honestly. */
export default function ZonesPage() {
  const zones = useQuery({ queryKey: ['zones'], queryFn: fetchZones });
  const rows: any[] = zones.data?.data ?? [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Delivery Zones</h1>
      <p className="text-[var(--muted)] text-sm mb-6">
        Active zones feed live fare pricing. Delivery range is additionally enforced per vendor and per market via
        CountryConfig. Map-based drawing and editing are a planned enhancement — zones are managed via the API today.
      </p>

      {zones.isLoading ? (
        <p className="text-sm text-[var(--muted)]">Loading zones…</p>
      ) : zones.isError ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--bad)' }}>
          Couldn&apos;t load zones: {(zones.error as Error).message}
        </p>
      ) : rows.length === 0 ? (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-12 flex flex-col items-center justify-center text-center">
          <Map size={48} className="text-[var(--muted)] mb-4" />
          <h2 className="text-lg font-semibold mb-2">No zones configured yet</h2>
          <p className="text-[var(--muted)] text-sm max-w-md">
            When zones are created (via the API for now), they appear here and start driving zone fares.
          </p>
        </div>
      ) : (
        <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-[var(--muted)] border-b border-[var(--border)]">
                <th className="px-4 py-3">Zone</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Base fee</th>
                <th className="px-4 py-3">Per km</th>
                <th className="px-4 py-3">Surge ×</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((z: any) => (
                <tr key={z.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{z.name}</p>
                    {z.description ? <p className="text-xs text-[var(--muted)]">{z.description}</p> : null}
                  </td>
                  <td className="px-4 py-3">
                    <span className={z.isActive ? 'text-green-400' : 'text-[var(--muted)]'}>
                      {z.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">{z.deliveryBaseFee != null ? `G$${Number(z.deliveryBaseFee).toLocaleString()}` : '—'}</td>
                  <td className="px-4 py-3">{z.deliveryPerKm != null ? `G$${Number(z.deliveryPerKm).toLocaleString()}` : '—'}</td>
                  <td className="px-4 py-3">{Number(z.surgeMultiplier ?? 1).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
