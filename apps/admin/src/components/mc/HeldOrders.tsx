'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchHeldOrders, releaseHeldOrder, type HeldOrder } from '@/lib/api';
import { label } from '@/lib/labels';
import { DataTable } from './DataTable';
import { QueryFailed } from './QueryFailed';
import { StatusBadge } from './StatusBadge';
import { Truncate } from './Truncate';
import { useActionRunner } from './useActionRunner';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · AD4] HELD ORDERS — the door the hold promised.
//
// A paid MMG order that sat ready past the food-age cutoff is not cancelled;
// it is held for a person (GET /admin/orders/held). Until now no screen read
// that queue, so a held order waited on a door that did not exist. This lists
// them, oldest first, and offers the one release the server has today:
// "Deliver anyway" (POST /orders/:id/food-age-hold/release). The other exit —
// close it after the store refunds — the server refuses until the refund
// ledger exists, so it is not offered. A failed read says so; it never reads
// as "nothing held".
// ---------------------------------------------------------------------------

const gyd = (n: unknown) => `G$${Number(n || 0).toLocaleString('en-GY', { maximumFractionDigits: 2 })}`;
const minutes = (m: number | null) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

export function HeldOrders() {
  const qc = useQueryClient();
  const held = useQuery({ queryKey: ['orders-held'], queryFn: fetchHeldOrders, refetchInterval: 60_000 });
  const actions = useActionRunner(() => {
    void qc.invalidateQueries({ queryKey: ['orders-held'] });
    void qc.invalidateQueries({ queryKey: ['orders'] });
  });
  const rows: HeldOrder[] = held.data?.data ?? [];

  const deliver = (o: HeldOrder) => void actions.run({
    title: `Deliver order ${o.orderNumber} anyway?`,
    body: (
      <>
        <p>
          It was paid by MMG and has been ready for {minutes(o.readyMinutes)}, past the food-age limit, so Swift held it
          instead of cancelling it. Delivering it sends it straight back to finding a rider.
        </p>
        <p>Do this only when {o.vendor?.name ?? 'the store'} confirms the order is still fit to deliver.</p>
      </>
    ),
    confirmLabel: 'Deliver anyway',
    reason: false,
    submit: () => releaseHeldOrder(o.id),
    success: () => `Order ${o.orderNumber} is released and back with dispatch.`,
  });

  if (held.isError) {
    return (
      <section aria-labelledby="held-orders" className="mb-5">
        <h2 id="held-orders" className="mc-label">Held for review</h2>
        <QueryFailed error={held.error} what="the held orders" onRetry={() => void held.refetch()} retrying={held.isFetching} />
      </section>
    );
  }
  if (!rows.length && !actions.result) return null;
  return (
    <section aria-labelledby="held-orders" className="mc-card mc-door mb-5 space-y-3">
      <h2 id="held-orders" className="mc-label">Held for review · {rows.length}</h2>
      <p className="mc-muted">
        Paid MMG orders that were ready too long. Each waits for a person: deliver it anyway once the store confirms it
        is still fit, or leave it held.
      </p>
      {actions.banner}
      {rows.length > 0 ? (
        <DataTable<HeldOrder>
          label="Orders held for review"
          rows={rows}
          rowKey={(o) => o.id}
          empty="No orders are held."
          columns={[
            { key: 'order', header: 'Order', width: '18%', primary: true, cell: (o) => <Link href={`/orders/${o.id}`}><Truncate text={o.orderNumber} /></Link> },
            { key: 'store', header: 'Store', width: '22%', cell: (o) => <Truncate text={o.vendor?.name ?? '—'} /> },
            { key: 'status', header: 'Status', width: '18%', cell: (o) => <StatusBadge group="OrderStatus" value={o.status} /> },
            { key: 'held', header: 'Held for', width: '12%', cell: (o) => minutes(o.heldMinutes) },
            { key: 'total', header: 'Total', width: '10%', align: 'right', cell: (o) => <span className="mc-numbers">{gyd(o.totalAmount)}</span> },
            {
              key: 'act', header: 'Action', width: '20%',
              cell: (o) => <button type="button" className="mc-btn" onClick={() => deliver(o)} aria-label={`Deliver order ${o.orderNumber} anyway`}>Deliver anyway…</button>,
            },
          ]}
        />
      ) : null}
      <p className="mc-muted text-xs">{label('PaymentMethod', 'MOBILE_MONEY')} orders only. Closing an order after the store refunds it is not available yet.</p>
    </section>
  );
}
