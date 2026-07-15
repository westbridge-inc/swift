'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchOrders, cancelOrder } from '@/lib/api';
import { statusClass } from '@/lib/status';

// Orders past these states can't be cancelled/refunded by an operator.
const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

export default function OrdersPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['orders'], queryFn: () => fetchOrders() });
  const cancelMutation = useMutation({
    mutationFn: ({ id, refund }: { id: string; refund: boolean }) =>
      cancelOrder(id, { reason: 'Cancelled by admin', refund }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Orders</h1>
      <div className="bg-[#1C1C1E] rounded-xl border border-[#38383A] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#38383A]">
              <th className="text-left p-4 text-[#8E8E93] font-medium">Order #</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Type</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Fulfillment</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Status</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Payment</th>
              <th className="text-left p-4 text-[#8E8E93] font-medium">Vendor</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Total</th>
              <th className="text-right p-4 text-[#8E8E93] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-[#38383A]">
                  <td colSpan={8} className="p-4">
                    <div className="h-5 w-full rounded bg-[#2C2C2E] animate-pulse" />
                  </td>
                </tr>
              ))
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={8} className="p-8 text-center text-[#8E8E93]">No orders yet</td></tr>
            ) : (
              data?.data?.map((order: any) => (
                <tr key={order.id} className="border-b border-[#38383A] hover:bg-white/5">
                  <td className="p-4 font-mono">
                    <Link href={`/orders/${order.id}`} className="hover:text-[#E8192C] transition-colors">
                      {order.orderNumber}
                    </Link>
                  </td>
                  <td className="p-4">{order.orderType}</td>
                  <td className="p-4">
                    {order.fulfillment === 'PICKUP' ? (
                      <span className="text-[#E8192C] font-medium">
                        Takeaway{order.pickupCode ? ` · ${order.pickupCode}` : ''}
                      </span>
                    ) : (
                      <span className="text-[#8E8E93]">
                        {order.fulfillment === 'APPOINTMENT' ? 'Appointment' : 'Delivery'}
                      </span>
                    )}
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs ${statusClass(order.status)}`}>{order.status}</span>
                  </td>
                  <td className="p-4">
                    {order.paymentMethod === 'MOBILE_MONEY' ? (
                      order.paymentStatus === 'CAPTURED' ? (
                        <span className="px-2 py-1 rounded-full text-xs bg-emerald-500/15 text-emerald-400">MMG {'\u00b7'} paid</span>
                      ) : (
                        <span className="px-2 py-1 rounded-full text-xs bg-amber-500/15 text-amber-400">MMG {'\u00b7'} awaiting</span>
                      )
                    ) : (
                      <span className="text-[#8E8E93] text-xs">{order.paymentMethod === 'CASH' ? 'Cash' : order.paymentMethod || '\u2014'}</span>
                    )}
                  </td>
                  <td className="p-4">{order.vendor?.name || '\u2014'}</td>
                  <td className="p-4 text-right">${Number(order.totalAmount).toLocaleString()}</td>
                  <td className="p-4 text-right">
                    {TERMINAL.includes(order.status) ? (
                      <span className="text-[#8E8E93]">—</span>
                    ) : (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => { if (window.confirm(`Cancel order ${order.orderNumber}?`)) cancelMutation.mutate({ id: order.id, refund: false }); }}
                          disabled={cancelMutation.isPending}
                          className="px-3 py-1 rounded-lg text-xs border border-[#38383A] text-white hover:bg-white/10 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => { if (window.confirm(`Cancel order ${order.orderNumber} AND refund cash paid?`)) cancelMutation.mutate({ id: order.id, refund: true }); }}
                          disabled={cancelMutation.isPending}
                          className="px-3 py-1 rounded-lg text-xs bg-[#E8192C] text-white hover:bg-[#E8192C]/80 disabled:opacity-50"
                        >
                          Refund
                        </button>
                      </div>
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
