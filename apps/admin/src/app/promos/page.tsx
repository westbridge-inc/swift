'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchPromos } from '@/lib/api';

export default function PromosPage() {
  const { data, isLoading } = useQuery({ queryKey: ['promos'], queryFn: fetchPromos });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Promo Codes</h1>
        <button className="px-4 py-2 bg-[#E8192C] text-white rounded-lg text-sm hover:bg-[#E8192C]/80">
          Create Promo
        </button>
      </div>
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Code</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Type</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Discount</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Uses</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Expires</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="p-8 text-center text-[#8E8E93]">Loading...</td></tr>
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={6} className="p-8 text-center text-[#8E8E93]">No promo codes yet</td></tr>
            ) : (
              data?.data?.map((promo: any) => (
                <tr key={promo.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-mono font-medium">{promo.code}</td>
                  <td className="p-4">{promo.discountType}</td>
                  <td className="p-4">
                    {promo.discountType === 'PERCENTAGE'
                      ? `${promo.discountValue}%`
                      : `$${Number(promo.discountValue).toLocaleString()}`}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      promo.isActive ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
                    }`}>{promo.isActive ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="p-4">{promo.currentUses} / {promo.maxUses || '\u221e'}</td>
                  <td className="p-4 text-right text-[#8E8E93]">
                    {promo.expiresAt ? new Date(promo.expiresAt).toLocaleDateString() : 'Never'}
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
