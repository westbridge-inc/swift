'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchVendors, approveVendor } from '@/lib/api';

export default function VendorsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['vendors'], queryFn: () => fetchVendors() });
  const approveMutation = useMutation({
    mutationFn: approveVendor,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vendors'] }),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Vendors</h1>
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Name</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Type</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Rating</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Orders</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="p-8 text-center text-[#8E8E93]">Loading...</td></tr>
            ) : (
              data?.data?.map((vendor: any) => (
                <tr key={vendor.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-medium"><Link href={`/vendors/${vendor.id}`} className="hover:text-[#E8192C] transition-colors">{vendor.name}</Link></td>
                  <td className="p-4">{vendor.vendorType}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      vendor.status === 'ACTIVE' ? 'bg-green-500/20 text-green-400' :
                      vendor.status === 'PENDING_APPROVAL' ? 'bg-yellow-500/20 text-yellow-400' :
                      'bg-red-500/20 text-red-400'
                    }`}>{vendor.status}</span>
                  </td>
                  <td className="p-4">{vendor.averageRating.toFixed(1)}</td>
                  <td className="p-4">{vendor.totalOrders}</td>
                  <td className="p-4 text-right">
                    {vendor.status === 'PENDING_APPROVAL' && (
                      <button
                        onClick={() => approveMutation.mutate(vendor.id)}
                        className="px-3 py-1 bg-[#E8192C] text-white rounded-lg text-xs hover:bg-[#E8192C]/80"
                      >
                        Approve
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
