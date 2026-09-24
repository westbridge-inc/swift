'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchDrivers, verifyDriverDocuments, setDriverRideClass } from '@/lib/api';
import { askReason } from '@/lib/ask-reason';

const RIDE_CLASSES = ['ECONOMY', 'COMFORT', 'XL'] as const;

export default function DriversPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['drivers'], queryFn: fetchDrivers });
  const verifyMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => verifyDriverDocuments(id, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['drivers'] }),
  });
  const rideClassMutation = useMutation({
    mutationFn: ({ id, rideClass, reason }: { id: string; rideClass: string; reason: string }) => setDriverRideClass(id, rideClass, reason),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['drivers'] }),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Drivers</h1>
      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">Name</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Phone</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Vehicle</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Tier</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Status</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Documents</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Rating</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Total Trips</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={9} className="p-8 text-center text-[var(--muted)]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={9} className="p-8 text-center text-[var(--muted)]">No drivers found</td></tr>
            ) : (
              data?.data?.map((driver: any) => (
                <tr key={driver.id} className="border-b border-[var(--border)] hover:bg-white/5">
                  <td className="p-4 font-medium"><Link href={`/drivers/${driver.id}`} className="hover:text-[var(--accent)] transition-colors">{driver.user?.firstName} {driver.user?.lastName}</Link></td>
                  <td className="p-4">{driver.user?.phone || '—'}</td>
                  <td className="p-4">{driver.vehicleMake} {driver.vehicleModel}</td>
                  <td className="p-4">
                    <select
                      value={driver.rideClass ?? 'ECONOMY'}
                      disabled={rideClassMutation.isPending}
                      onChange={(e) => { const reason = askReason({ action: `set this driver's ride class to ${e.target.value}`, subject: `${driver.user?.firstName} ${driver.user?.lastName}` }); if (reason) rideClassMutation.mutate({ id: driver.id, rideClass: e.target.value, reason }); }}
                      className="bg-[var(--panel-2)] border border-[var(--border)] rounded-lg px-2 py-1 text-xs text-white disabled:opacity-50"
                    >
                      {RIDE_CLASSES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      driver.isOnline ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                    }`}>{driver.isOnline ? 'Online' : 'Offline'}</span>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      driver.documentsVerified ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
                    }`}>{driver.documentsVerified ? 'Verified' : 'Pending'}</span>
                  </td>
                  <td className="p-4">{driver.averageRating?.toFixed(1) || '—'}</td>
                  <td className="p-4">{driver.totalTrips || 0}</td>
                  <td className="p-4 text-right">
                    {!driver.documentsVerified && (
                      <button
                        onClick={() => { const reason = askReason({ action: 'verify these documents', subject: `${driver.user?.firstName} ${driver.user?.lastName}` }); if (reason) verifyMutation.mutate({ id: driver.id, reason }); }}
                        disabled={verifyMutation.isPending}
                        className="px-3 py-1 bg-[var(--accent)] text-white rounded-lg text-xs hover:bg-[var(--accent)]/80 disabled:opacity-50"
                      >
                        Verify Docs
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
