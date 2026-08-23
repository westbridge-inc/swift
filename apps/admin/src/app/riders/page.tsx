'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchRiders, verifyRiderDocuments } from '@/lib/api';

export default function RidersPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['riders'], queryFn: fetchRiders });
  const verifyMutation = useMutation({
    mutationFn: verifyRiderDocuments,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['riders'] }),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Riders</h1>
      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">Name</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Phone</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Type</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Status</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Documents</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Rating</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-8 text-center text-[var(--muted)]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={7} className="p-8 text-center text-[var(--muted)]">No riders found</td></tr>
            ) : (
              data?.data?.map((rider: any) => (
                <tr key={rider.id} className="border-b border-[var(--border)] hover:bg-white/5">
                  <td className="p-4 font-medium"><Link href={`/riders/${rider.id}`} className="hover:text-[var(--accent)] transition-colors">{rider.user?.firstName} {rider.user?.lastName}</Link></td>
                  <td className="p-4">{rider.user?.phone || '\u2014'}</td>
                  <td className="p-4">{rider.riderType}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      rider.isOnline ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                    }`}>{rider.isOnline ? 'Online' : 'Offline'}</span>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      rider.documentsVerified ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
                    }`}>{rider.documentsVerified ? 'Verified' : 'Pending'}</span>
                  </td>
                  <td className="p-4">{rider.averageRating?.toFixed(1) || '\u2014'}</td>
                  <td className="p-4 text-right">
                    {!rider.documentsVerified && (
                      <button
                        onClick={() => verifyMutation.mutate(rider.id)}
                        className="px-3 py-1 bg-[var(--accent)] text-white rounded-lg text-xs hover:bg-[var(--accent)]/80"
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
