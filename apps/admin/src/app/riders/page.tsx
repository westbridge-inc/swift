'use client';

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
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Name</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Phone</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Type</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Documents</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Rating</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-8 text-center text-[#8E8E93]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={7} className="p-8 text-center text-[#8E8E93]">No riders found</td></tr>
            ) : (
              data?.data?.map((rider: any) => (
                <tr key={rider.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-medium">{rider.user?.firstName} {rider.user?.lastName}</td>
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
                        className="px-3 py-1 bg-[#E8192C] text-white rounded-lg text-xs hover:bg-[#E8192C]/80"
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
