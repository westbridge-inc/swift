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
      {cancelMutation.error ? (
        // [WR-005] The server fail-closes MMG refunds (409 MMG_REFUND_UNAVAILABLE
        // until LB-019) and rejects invalid transitions — the admin must SEE
        // that, not watch the click vanish.
        <p role="alert" className="text-xs mb-3" style={{ color: 'var(--bad)' }}>
          Order action did not confirm: {(cancelMutation.error as Error).message}
        </p>
      ) : null}
      <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left p-4 text-[var(--muted)] font-medium">Order #</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Type</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Fulfillment</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Status</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Payment</th>
              <th className="text-left p-4 text-[var(--muted)] font-medium">Vendor</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Total</th>
              <th className="text-right p-4 text-[var(--muted)] font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  <td colSpan={8} className="p-4">
                    <div className="h-5 w-full rounded bg-[var(--panel-2)] animate-pulse" />
                  </td>
                </tr>
              ))
            ) : data?.data?.length === 0 ? (
              <tr><td colSpan={8} className="p-8 text-center text-[var(--muted)]">No orders yet</td></tr>
            ) : (
              data?.data?.map((order: any) => (
                <tr key={order.id} className="border-b border-[var(--border)] hover:bg-white/5">
                  <td className="p-4 font-mono">
                    <Link href={`/orders/${order.id}`} className="hover:text-[var(--accent)] transition-colors">
                      {order.orderNumber}
                    </Link>
                  </td>
                  <td className="p-4">{order.orderType}</td>
                  <td className="p-4">
                    {order.fulfillment === 'PICKUP' ? (
                      <span className="text-[var(--accent)] font-medium">
                        Takeaway{order.pickupCode ? ` · ${order.pickupCode}` : ''}
                      </span>
                    ) : (
                      <span className="text-[var(--muted)]">
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
                      <span className="text-[var(--muted)] text-xs">{order.paymentMethod === 'CASH' ? 'Cash' : order.paymentMethod || '\u2014'}</span>
                    )}
                  </td>
                  <td className="p-4">{order.vendor?.name || '\u2014'}</td>
                  <td className="p-4 text-right">${Number(order.totalAmount).toLocaleString()}</td>
                  <td className="p-4 text-right">
                    {TERMINAL.includes(order.status) ? (
                      <span className="text-[var(--muted)]">—</span>
                    ) : (
                      <div className="flex gap-2 justify-end">
                        <button
                          onClick={() => { const mmgNote = order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus !== 'CAPTURED' ? '\n\nMMG payment unconfirmed: the customer gets direct-refund guidance and the store is told it may hold the transfer.' : ''; if (window.confirm(`Cancel order ${order.orderNumber}?${mmgNote}`)) cancelMutation.mutate({ id: order.id, refund: false }); }}
                          disabled={cancelMutation.isPending}
                          className="px-3 py-1 rounded-lg text-xs border border-[var(--border)] text-white hover:bg-white/10 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => { if (window.confirm(`Cancel order ${order.orderNumber} AND refund cash paid?`)) cancelMutation.mutate({ id: order.id, refund: true }); }}
                          disabled={cancelMutation.isPending}
                          className="px-3 py-1 rounded-lg text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent)]/80 disabled:opacity-50"
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
