'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchOrders } from '@/lib/api';
import { statusClass } from '@/lib/status';

export default function OrdersPage() {
  const { data, isLoading } = useQuery({ queryKey: ['orders'], queryFn: () => fetchOrders() });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Orders</h1>
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Order #</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Type</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Vendor</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-[#38383A]">
                  <td colSpan={5} className="p-4">
                    <div className="h-5 w-full rounded bg-[#2C2C2E] animate-pulse" />
                  </td>
                </tr>
              ))
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={5} className="p-8 text-center text-[#8E8E93]">No orders yet</td></tr>
            ) : (
              data?.data?.map((order: any) => (
                <tr key={order.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-mono">{order.orderNumber}</td>
                  <td className="p-4">{order.orderType}</td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${statusClass(order.status)}`}>{order.status}</span>
                  </td>
                  <td className="p-4">{order.vendor?.name || '\u2014'}</td>
                  <td className="p-4 text-right">${Number(order.totalAmount).toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
