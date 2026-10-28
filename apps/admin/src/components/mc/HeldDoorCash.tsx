'use client';

import { useQueryClient } from '@tanstack/react-query';
import { resolveHeldDoorCash } from '@/lib/api';
import type { useActionRunner } from './useActionRunner';
import { gyDateTime } from '@/lib/dates';

// ---------------------------------------------------------------------------
// [L02 · row 34 · review S3-1 of #1542] PARTIAL CASH A RIDER STILL HOLDS.
//
// When a customer cannot pay in full, the goods go back to the store and any
// cash the rider already took is recorded as handed back, or as HELD: still
// with the rider, for operations to follow up. While it is held, the rider's
// account closure waits on it. The server's resolve action
// (POST /orders/:id/door-cash-return/resolve, C4) is the only way out of HELD;
// this is its console button. A record only: Swift moves, refunds and deducts
// nothing. The first ask answers 202 APPROVAL_REQUIRED; a second admin (or the
// owner's solo approval) decides it in Approvals.
// ---------------------------------------------------------------------------

/** The order fields this reads (GET /admin/orders/:id returns the order row). */
export interface HeldDoorCashFacts {
  id: string;
  orderNumber: string;
  doorCashReturnStatus?: string | null;
  doorCashReturnAmount?: string | number | null;
  doorCashReturnRecordedAt?: string | null;
  doorCashReturnResolvedAt?: string | null;
}

const when = (iso: string) => gyDateTime(iso);
const gyd = (amount: unknown) => `GY$${Number(amount ?? 0).toLocaleString()}`;

export function HeldDoorCash({ order, actions }: { order: HeldDoorCashFacts; actions: ReturnType<typeof useActionRunner> }) {
  const qc = useQueryClient();
  const amount = gyd(order.doorCashReturnAmount);

  if (order.doorCashReturnStatus === 'RESOLVED') {
    return (
      <section aria-label="Held cash" className="mc-card mc-door mb-4">
        <p className="mc-label">Held cash — recorded as resolved</p>
        <p className="mc-muted">
          The {amount} the rider held is recorded as resolved{order.doorCashReturnResolvedAt ? ` (${when(order.doorCashReturnResolvedAt)})` : ''}. The reason is in the audit log.
        </p>
      </section>
    );
  }
  if (order.doorCashReturnStatus !== 'HELD') return null;

  const resolve = () => void actions.run({
    title: `Record the held cash for order ${order.orderNumber} as resolved?`,
    body: (
      <p>
        This records that the {amount} the rider held is settled — handed back to the customer later, or otherwise — as your reason says. It is a record only: Swift moves, refunds and deducts nothing. A second admin must approve it (or the owner&apos;s solo approval) before it applies.
      </p>
    ),
    confirmLabel: 'Record as resolved',
    reason: { hint: 'How the cash was settled: who handed what back, when, and what you checked.' },
    submit: async ({ reason }) => {
      try { return await resolveHeldDoorCash(order.id, reason); }
      catch (error) {
        // A refusal can mean the record on screen is gone (resolved by someone
        // else): re-read the order so the button stops being offered.
        await qc.invalidateQueries({ queryKey: ['order', order.id] });
        throw error;
      }
    },
    success: () => `Order ${order.orderNumber}: the held cash is recorded as resolved.`,
  });

  return (
    <section aria-label="Held cash" className="mc-card mc-door mb-4 space-y-2" style={{ borderColor: 'var(--mc-warn, #d08b4c)' }}>
      <p className="mc-label">Held cash — waiting for operations</p>
      <p>
        The customer could not pay in full and the goods went back to the store. The rider still holds {amount} of the customer&apos;s cash
        {order.doorCashReturnRecordedAt ? ` (recorded ${when(order.doorCashReturnRecordedAt)})` : ''}. The rider&apos;s account closure waits until this is resolved.
      </p>
      <p className="mc-muted">Swift moves no money. Record it as resolved once the cash is settled.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="mc-btn" onClick={resolve}>Record held cash as resolved…</button>
      </div>
    </section>
  );
}
