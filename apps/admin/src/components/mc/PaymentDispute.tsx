'use client';

import { useQueryClient } from '@tanstack/react-query';
import { resolvePaymentDispute, errorCode } from '@/lib/api';
import type { useActionRunner } from './useActionRunner';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · AD5] AN MMG PAYMENT DISPUTE ON A STORE ORDER — decided here.
//
// A direct-MMG order is paid customer → store outside Swift: the only signals
// are the store's "it arrived" and the customer's "I paid" / "I did not pay".
// When they disagree the order is paused (the store's app says "Payment under
// review") until a person decides (POST /orders/:id/payment-claim/resolve).
// No screen offered that decision. Here it is, bound to the claim revision the
// operator is looking at: if either side spoke since, the server refuses and
// the page re-reads. No money moves either way — the decision records whose
// account stands.
// ---------------------------------------------------------------------------

/** The order fields the dispute reads (GET /admin/orders/:id returns the order row). */
export interface DisputeFacts {
  id: string;
  orderNumber: string;
  paymentMethod: string;
  paymentStatus: string;
  customerPaymentRef?: string | null;
  mmgAttestedRef?: string | null;
  customerMmgClaim?: string | null;
  mmgClaimMismatchAt?: string | null;
  mmgClaimRevision?: number | null;
  mmgClaimResolution?: string | null;
  mmgClaimResolvedAt?: string | null;
  /** The claim generation the latest decision produced; it covers the facts only while it equals mmgClaimRevision. */
  mmgClaimResolvedRevision?: number | null;
  vendor?: { name?: string | null } | null;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const CUSTOMER_WORDS: Record<string, string> = { PAID: 'says they paid', NOT_PAID: 'says they did not pay', UNRECORDED: 'has not said' };
const STORE_WORDS: Record<string, string> = { CLAIMED: 'says the payment arrived', CAPTURED: 'MMG confirmed the payment', PENDING: 'has not confirmed a payment' };

export function PaymentDispute({ order, actions }: { order: DisputeFacts; actions: ReturnType<typeof useActionRunner> }) {
  const qc = useQueryClient();
  if (order.paymentMethod !== 'MOBILE_MONEY') return null;
  const store = order.vendor?.name ?? 'The store';
  if (!order.mmgClaimMismatchAt) {
    if (!order.mmgClaimResolution || !order.mmgClaimResolvedAt) return null;
    // A decision covers the claim facts only while its revision is the current one. Once a later
    // statement moves the revision on, it is an earlier decision, not the current state [REVIEW-B #1699 S4-3].
    const current = order.mmgClaimResolvedRevision != null && order.mmgClaimResolvedRevision === order.mmgClaimRevision;
    const outcome = order.mmgClaimResolution === 'CUSTOMER_PAID' ? 'the customer paid.' : 'the customer did not pay.';
    return (
      <section aria-label="Payment dispute" className="mc-card mc-door mb-4">
        <p className="mc-label">{current ? 'Payment dispute — decided' : 'Payment dispute — earlier decision'}</p>
        <p className="mc-muted">
          {current ? `Decided: ${outcome}` : `Earlier decision: ${outcome}`} {when(order.mmgClaimResolvedAt)}.
          {!current && ' The payment claims changed after it.'}
        </p>
      </section>
    );
  }
  const revision = Number(order.mmgClaimRevision ?? 0);
  const decide = (resolution: 'CUSTOMER_PAID' | 'CUSTOMER_DID_NOT_PAY') => {
    let stale = false;
    return void actions.run({
    title: resolution === 'CUSTOMER_PAID' ? `Decide that the customer paid for order ${order.orderNumber}?` : `Decide that the customer did not pay for order ${order.orderNumber}?`,
    body: resolution === 'CUSTOMER_PAID' ? (
      <p>The store&apos;s record that the payment arrived stands, and the order is no longer paused. No money moves: MMG payments are between the customer and {store}.</p>
    ) : (
      <p>The store&apos;s claim is set aside and the order waits for a payment again. This is refused if MMG confirmed the money or the goods have already left the store.</p>
    ),
    confirmLabel: resolution === 'CUSTOMER_PAID' ? 'Customer paid' : 'Customer did not pay',
    reason: { hint: 'What you checked (the MMG statement, both parties) and what it showed. The parties are told the outcome, not your note.' },
    submit: async ({ reason }) => {
      if (stale) throw Object.assign(new Error('Close this panel and review the refreshed payment evidence before deciding again.'), { status: 409, code: 'MMG_CLAIM_STALE' });
      try { return await resolvePaymentDispute(order.id, { resolution, expectedClaimRevision: revision }, reason); }
      catch (error) {
        // Any refusal or unreadable answer can mean the facts on screen are gone (decided by
        // someone else, no longer disputed, order closed): re-read the order so the panel stops
        // offering decisions on them [REVIEW-B #1699 S4-2]. Only a stale revision also blocks a
        // re-send from this panel.
        if (errorCode(error) === 'MMG_CLAIM_STALE') stale = true;
        await qc.invalidateQueries({ queryKey: ['order', order.id] });
        throw error;
      }
    },
    success: () => (resolution === 'CUSTOMER_PAID' ? `Order ${order.orderNumber}: decided that the customer paid.` : `Order ${order.orderNumber}: decided that the customer did not pay.`),
    });
  };
  return (
    <section aria-label="Payment dispute" className="mc-card mc-door mb-4 space-y-2" style={{ borderColor: 'var(--mc-warn, #d08b4c)' }}>
      <p className="mc-label">Payment dispute — waiting for your decision</p>
      <p>
        The customer {CUSTOMER_WORDS[order.customerMmgClaim ?? 'UNRECORDED'] ?? 'has spoken'}; {store}{' '}
        {STORE_WORDS[order.paymentStatus] ?? 'has spoken'}. Open since {when(order.mmgClaimMismatchAt)}. The order is paused until it is decided.
      </p>
      <dl className="mc-muted">
        <dt>Customer payment reference</dt><dd>{order.customerPaymentRef ?? 'Not provided'}</dd>
        <dt>Store payment reference</dt><dd>{order.mmgAttestedRef ?? 'Not provided'}</dd>
      </dl>
      {order.customerPaymentRef && order.mmgAttestedRef && order.customerPaymentRef.trim().toUpperCase() !== order.mmgAttestedRef.trim().toUpperCase() && <p>The payment references do not match. Check both records before deciding.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="mc-btn" onClick={() => decide('CUSTOMER_PAID')}>Customer paid…</button>
        <button type="button" className="mc-btn" onClick={() => decide('CUSTOMER_DID_NOT_PAY')}>Customer did not pay…</button>
      </div>
    </section>
  );
}
