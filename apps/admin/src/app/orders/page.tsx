'use client';

import { useState } from 'react';
import Link from 'next/link';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchOrders, cancelOrder } from '@/lib/api';
import { ENUM_LABELS, label } from '@/lib/labels';
import { EMPTY_LIST_STATE, listQueryString, type ListState } from '@/lib/list-query';
import type { Outcome } from '@/lib/outcome';
import { ActionResult } from '@/components/mc/ActionResult';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { useActionDialog } from '@/components/mc/ReasonDialog';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { Truncate } from '@/components/mc/Truncate';
import { DataTable } from '@/components/mc/DataTable';
import { ListToolbar, Pager } from '@/components/mc/ListControls';
import { HeldOrders } from '@/components/mc/HeldOrders';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3] Orders.
//
// Server paging, search (order number or address), status and type filters,
// test data hidden by default, plain words. Cancelling goes through the reason
// panel, which names the order and the store and states what happens to the
// money — and the server's answer is shown.
// ---------------------------------------------------------------------------

// Orders past these states can't be cancelled/refunded by an operator.
const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

interface OrderRow {
  id: string;
  orderNumber: string;
  orderType: string;
  fulfillment?: string | null;
  status: string;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  totalAmount: number;
  placedAt?: string | null;
  customer?: { firstName?: string | null; lastName?: string | null } | null;
  vendor?: { id: string; name: string } | null;
}

const gyd = (n: unknown) => `G$${Number(n || 0).toLocaleString('en-GY', { maximumFractionDigits: 2 })}`;
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function payment(o: OrderRow): string {
  const method = label('PaymentMethod', o.paymentMethod);
  if (o.paymentMethod === 'MOBILE_MONEY') return `${method} · ${o.paymentStatus === 'CAPTURED' ? 'paid' : 'not paid yet'}`;
  return method;
}

export default function OrdersPage() {
  const qc = useQueryClient();
  const dialog = useActionDialog();
  const [state, setState] = useState<ListState>(EMPTY_LIST_STATE);
  const [result, setResult] = useState<Outcome | null>(null);
  const list = useQuery({ queryKey: ['orders', state], queryFn: () => fetchOrders(listQueryString(state)), placeholderData: keepPreviousData });
  const rows: OrderRow[] = list.data?.data ?? [];

  const cancel = async (o: OrderRow, refund: boolean) => {
    const store = o.vendor?.name ?? 'the store';
    const outcome = await dialog.run({
      title: refund ? `Cancel order ${o.orderNumber} and record a refund owed?` : `Cancel order ${o.orderNumber}?`,
      body: refund ? (
        <p>
          This records that {store} OWES the customer a refund. It does not mark anything refunded — settle it on the
          order page once the reference and the amount handed back are known.
        </p>
      ) : o.paymentMethod === 'MOBILE_MONEY' ? (
        <p>MMG payment stays between customer and store. If paid, it is refunded by {store}; Swift cannot refund it.</p>
      ) : (
        <p>The customer and {store} are told the order is cancelled.</p>
      ),
      confirmLabel: refund ? 'Cancel and record refund owed' : 'Cancel order',
      reason: { hint: 'The customer is owed the real reason; it is kept on the permanent record.' },
      submit: ({ reason }) => cancelOrder(o.id, { refund }, reason),
      success: () => (refund ? `Order ${o.orderNumber} is cancelled; ${store} owes the customer a refund.` : `Order ${o.orderNumber} is cancelled.`),
    });
    if (!outcome) return;
    setResult(outcome);
    void qc.invalidateQueries({ queryKey: ['orders'] });
  };

  return (
    <div className="mc-page">
      <h1 className="mc-numbers text-2xl font-semibold mb-4" style={{ letterSpacing: '-0.02em' }}>Orders</h1>
      <ActionResult outcome={result} onDismiss={() => setResult(null)} className="mb-4" />
      {/* [MC-AD4] paid MMG orders held for a person's decision */}
      <HeldOrders />
      <ListToolbar
        state={state}
        onChange={setState}
        searchLabel="Search by order number or address"
        filters={[
          { key: 'status', label: 'Status', options: [['', 'Any status'], ...Object.entries(ENUM_LABELS.OrderStatus)] },
          { key: 'type', label: 'Type', options: [['', 'All types'], ...Object.entries(ENUM_LABELS.OrderType)] },
        ]}
      />
      {list.isLoading ? (
        <div className="mc-card" aria-busy="true">Loading orders…</div>
      ) : list.isError ? (
        <QueryFailed error={list.error} what="the order list" onRetry={() => void list.refetch()} retrying={list.isFetching} />
      ) : (
        <>
          <DataTable<OrderRow>
            label="Orders"
            rows={rows}
            rowKey={(o) => o.id}
            empty={state.search || Object.values(state.filters).some(Boolean) ? 'No order matches this search.' : 'No orders yet.'}
            columns={[
              {
                key: 'order', header: 'Order', width: '18%', primary: true,
                cell: (o) => (
                  <Link href={`/orders/${o.id}`} className="block min-w-0">
                    <Truncate text={o.orderNumber} />
                    <span className="mc-cell-sub">
                      {label('OrderType', o.orderType)}{o.fulfillment === 'PICKUP' ? ' · customer pickup' : o.fulfillment === 'APPOINTMENT' ? ' · appointment' : ''}
                    </span>
                  </Link>
                ),
              },
              { key: 'store', header: 'Store', width: '17%', cell: (o) => <Truncate text={o.vendor?.name ?? '—'} /> },
              { key: 'customer', header: 'Customer', width: '15%', cell: (o) => <Truncate text={[o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || '—'} /> },
              { key: 'status', header: 'Status', width: '18%', cell: (o) => <StatusBadge group="OrderStatus" value={o.status} /> },
              { key: 'payment', header: 'Payment', width: '13%', cell: (o) => payment(o) },
              { key: 'total', header: 'Total', width: '10%', align: 'right', cell: (o) => <span className="mc-numbers">{gyd(o.totalAmount)}</span> },
              { key: 'placed', header: 'Placed', width: '12%', cell: (o) => when(o.placedAt) },
              {
                key: 'actions', header: 'Actions', width: '13rem', align: 'right',
                cell: (o) => (TERMINAL.includes(o.status) ? null : (
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className="mc-btn" aria-label={`Cancel order ${o.orderNumber}…`} onClick={() => void cancel(o, false)}>Cancel…</button>
                    {o.paymentMethod === 'CASH' ? (
                      <button type="button" className="mc-btn mc-btn-danger" aria-label={`Record refund owed for ${o.orderNumber}…`} onClick={() => void cancel(o, true)}>Refund owed…</button>
                    ) : null}
                  </div>
                )),
              },
            ]}
          />
          <Pager meta={list.data?.meta} shown={rows.length} onPage={(page) => setState({ ...state, page })} onShowTestData={() => setState({ ...state, showTestData: true, page: 1 })} />
        </>
      )}
    </div>
  );
}
