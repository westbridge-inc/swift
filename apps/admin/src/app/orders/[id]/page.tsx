'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { fetchOrderDetail, cancelOrder, settleOrderRefund, revealOrderPartyPhone, type OrderContactParty } from '@/lib/api';
import { StatusBadge } from '@/components/mc/StatusBadge';
import { label } from '@/lib/labels';
import { QueryFailed } from '@/components/mc/QueryFailed';
import { PaymentDispute } from '@/components/mc/PaymentDispute';
import { HeldDoorCash } from '@/components/mc/HeldDoorCash';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { gyDateTime, gyTime } from '@/lib/dates';

const gyd = (n: unknown) => `$${Number(n || 0).toLocaleString()}`;
const clock = (iso: string | null | undefined) =>
  iso ? gyTime(iso) : '';

/** [TAXI multi-stop 8/8] One stop of a ride, as the server reports it. */
type RideStop = {
  sequence: number; address: string; status: 'PENDING' | 'ARRIVED' | 'DEPARTED' | 'SKIPPED';
  arrivedAt: string | null; departedAt: string | null; skippedAt: string | null; skipReason: string | null;
  evidenceNote: string | null;
};

/** Where the ride stands at a stop, in plain words, with the server's times. */
function stopProgress(stop: RideStop, next: number | null): string {
  if (stop.status === 'ARRIVED') return `Waiting here since ${clock(stop.arrivedAt)}`;
  if (stop.status === 'DEPARTED') return `Arrived ${clock(stop.arrivedAt)} · left ${clock(stop.departedAt)}`;
  if (stop.status === 'SKIPPED') return `Skipped ${clock(stop.skippedAt)}${stop.skipReason ? ` — ${stop.skipReason}` : ''}`;
  return stop.sequence === next ? 'Next stop' : 'Not reached yet';
}
const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mc-card">
      <h2 className="mc-label mb-3">{title}</h2>
      {children}
    </div>
  );
}

/**
 * [O-1] A party on the order. The server sends the phone MASKED; "Show number"
 * reads the full one through the audited door (a reason, recorded before the
 * number is sent), and only for this page view.
 */
function Party({ label, name, phone, href, revealed, onReveal }: {
  label: string; name?: string | null; phone?: string | null; href?: string;
  revealed?: string; onReveal?: () => void;
}) {
  if (!name) return null;
  return (
    <div className="flex items-center justify-between rounded-[var(--mc-radius-sm)] bg-[var(--mc-surface)] p-3">
      <div>
        <p className="mc-muted text-xs">{label}</p>
        {href ? (
          <Link href={href} className="text-sm font-medium text-[var(--mc-accent)] font-semibold">
            {name}
          </Link>
        ) : (
          <p className="text-sm font-medium">{name}</p>
        )}
      </div>
      {/* [MC shell] No click-to-call: calls are not a console feature (owner ruling, 6 Oct). */}
      {phone ? (
        <div className="flex flex-col items-end gap-1">
          <span className="mc-muted mc-numbers text-xs">{revealed ?? phone}</span>
          {revealed ? (
            <span className="mc-muted text-[11px]">Read recorded in the audit log</span>
          ) : onReveal ? (
            <button type="button" onClick={onReveal} className="mc-link-button text-xs">
              Show number
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['order', id], queryFn: () => fetchOrderDetail(id) });
  const actions = useActionRunner(() => {
    void queryClient.invalidateQueries({ queryKey: ['order', id] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  });
  // [U28] Cancelling, recording a refund owed and closing a refund each ask in
  // the panel: the order is named, a refusal stays in the panel with what was
  // typed, and a 202 (a refund close is C4) reads as queued, never a failure.
  const [refundCloseQueued, setRefundCloseQueued] = useState(false);
  // [O-1] Full numbers read through the audited door, for this page view only.
  const [revealed, setRevealed] = useState<Partial<Record<OrderContactParty, string>>>({});
  const o: any = data?.data;
  // [TAXI waiting charge] The ride's frozen breakdown, when the server sends one.
  const waiting: { routeFare: number; waitingMinutes: number; waitingCharge: number; total: number } | null =
    o?.fareBreakdown && typeof o.fareBreakdown.total === 'number' ? o.fareBreakdown : null;

  if (isLoading) {
    return <div className="mc-page"><div className="mc-loading" aria-busy="true">Loading the order…</div></div>;
  }
  if (isError || !o) {
    return (
      <div className="mc-page">
        <Link href="/orders" className="mc-back mb-2">
          <ArrowLeft size={16} /> Orders
        </Link>
        <QueryFailed error={error ?? new Error('The order response was empty.')} what="this order" onRetry={() => void refetch()} retrying={isFetching} />
      </div>
    );
  }

  const isRide = o.orderType === 'TAXI';
  const mover = o.rider?.user ?? o.driver?.user;
  const moverLabel = o.rider ? 'Rider' : o.driver ? 'Driver' : null;
  const isMmg = o.paymentMethod === 'MOBILE_MONEY';
  const refundingStore = o.vendor?.name ?? 'the store';
  const timeline: any[] = o.statusHistory ?? [];
  const revealFor = (party: OrderContactParty, who: string) => () => void actions.run({
    title: `Show the ${who}'s full number for order ${o.orderNumber}?`,
    body: <p>Your reason and this read are recorded in the audit log before the number is shown.</p>,
    confirmLabel: 'Show number',
    submit: ({ reason }) => revealOrderPartyPhone(id, party, reason),
    success: (result) => {
      setRevealed((now) => ({ ...now, [party]: result.data.phone }));
      return `The ${who}'s number is shown. The read is recorded.`;
    },
  });

  return (
    <div className="mc-page">
      <Link href="/orders" className="mc-back mb-2">
        <ArrowLeft size={16} /> Orders
      </Link>

      {actions.banner}
      <PaymentDispute order={o} actions={actions} />
      <HeldDoorCash order={o} actions={actions} />

      {/* Header — identity + the actions an operator actually has */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h2 className="mc-numbers text-2xl font-semibold" style={{ letterSpacing: '-0.02em' }}>#{o.orderNumber}</h2>
        <StatusBadge group="OrderStatus" value={o.status} />
        <span className="mc-badge">
          {label('OrderType', o.orderType)}
        </span>
        {isMmg ? (
          o.paymentStatus === 'CAPTURED' ? (
            <span className="mc-badge mc-tone-good">MMG paid</span>
          ) : (
            <span className="mc-badge mc-tone-warn">MMG awaiting confirmation</span>
          )
        ) : (
          <span className="mc-badge">cash</span>
        )}
        <div className="ml-auto flex gap-2">
          {!TERMINAL.includes(o.status) && (
            <>
              <button
                type="button"
                onClick={() => void actions.run({
                  title: `Cancel order ${o.orderNumber}?`,
                  body: isMmg
                    ? <p>MMG payment stays between customer and store. If paid, it is refunded by {refundingStore}; Swift cannot refund it.</p>
                    : <p>The customer, the store and any mover on it are told.</p>,
                  confirmLabel: 'Cancel order',
                  dismissLabel: 'Keep the order',
                  // [ADM-006] the operator's words, not a template
                  submit: ({ reason }) => cancelOrder(id, { refund: false }, reason),
                  success: () => `Order ${o.orderNumber} cancelled.`,
                })}
                className="mc-btn"
              >
                Cancel order
              </button>
              {o.paymentMethod === 'CASH' && (
                <button
                  type="button"
                  onClick={() => void actions.run({
                    title: `Cancel ${o.orderNumber} and record that ${refundingStore} owes the customer a refund?`,
                    body: <p>This does not mark anything refunded. The order stays in the outstanding list until someone records the reference and the amount actually handed back.</p>,
                    confirmLabel: 'Cancel and record refund owed',
                    dismissLabel: 'Keep the order',
                    submit: ({ reason }) => cancelOrder(id, { refund: true }, reason),
                    success: () => `Order ${o.orderNumber} cancelled; a refund is recorded as owed.`,
                  })}
                  className="mc-btn mc-btn-primary"
                >
                  Record refund owed
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* [A-14] An obligation nobody has settled is money the customer is still
          waiting for. It says so, with its age, until evidence closes it. */}
      {o.refundOwedAt && !o.refundSettledAt && (
        <div className="rounded-[var(--mc-radius)] border border-[var(--mc-warn)]/30 bg-[var(--mc-warn-soft)] p-4">
          <p className="text-sm mc-text-warn font-medium">Refund owed — not yet settled</p>
          <p className="mt-1 text-sm mc-muted">
            GY${Number(o.refundOwedAmount ?? 0).toLocaleString()} recorded as owed on{' '}
            {gyDateTime(o.refundOwedAt)}. Nothing here says the money moved.
          </p>
          <button
            type="button"
            onClick={() => void actions.run({
              title: `Record the refund handed back for order ${o.orderNumber}?`,
              body: <p>The order owes GY${Number(o.refundOwedAmount ?? 0).toLocaleString()}. Type the amount actually handed back and the receipt or handover reference.</p>,
              confirmLabel: 'Record refund handed back',
              fields: [
                { kind: 'reference', name: 'reference', label: 'Receipt or handover reference' },
                { kind: 'amount', name: 'amount', label: 'Amount actually handed back (GYD)', cents: true },
              ],
              // [A-14] Closing a refund is a separate act from deciding one is owed, and it
              // needs what a refund actually is: a reference and the amount handed back.
              submit: ({ reason, values }) => settleOrderRefund(id, String(values['reference']), Number(values['amount']), reason),
              success: () => 'Refund recorded as handed back.',
            }).then((outcome) => { if (outcome?.tone === 'queued') setRefundCloseQueued(true); })}
            disabled={refundCloseQueued}
            className="mt-3 px-4 py-2 rounded-lg text-sm bg-[var(--mc-accent)] disabled:opacity-50"
          >
            {refundCloseQueued ? 'Waiting for approval' : 'Record refund handed back'}
          </button>
        </div>
      )}

      {o.refundSettledAt && (
        <div className="rounded-[var(--mc-radius)] border border-[var(--mc-line)] p-4">
          <p className="text-sm font-medium">Refund settled</p>
          <p className="mt-1 text-sm mc-muted">
            GY${Number(o.refundPaidAmount ?? 0).toLocaleString()} — reference {o.refundRef} —{' '}
            {gyDateTime(o.refundSettledAt)}
          </p>
        </div>
      )}



      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left column — what + who */}
        <div className="lg:col-span-2 space-y-4">
          <Section title={isRide ? 'Trip' : 'Items'}>
            {isRide ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full border-2 border-[var(--mc-muted)]" />
                  <span>{o.pickupAddress ?? '—'}</span>
                </div>
                {/* [TAXI multi-stop 8/8] The stops in the passenger's order, each with where the ride stands. */}
                {Array.isArray(o.stops) &&
                  (o.stops as RideStop[]).map((stop) => (
                    <div key={stop.sequence} className="flex items-start gap-2" data-testid={`ride-stop-${stop.sequence}`}>
                      <span className="mt-0.5 w-4 text-center text-xs font-semibold mc-muted">{stop.sequence}</span>
                      <div>
                        <p>{stop.address}</p>
                        <p className="mc-muted text-xs">{stopProgress(stop, o.nextStopSequence ?? null)}</p>
                        {stop.evidenceNote ? <p className="mc-muted text-xs">{stop.evidenceNote}</p> : null}
                      </div>
                    </div>
                  ))}
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[var(--mc-accent)]" />
                  <span>{o.deliveryAddress ?? '—'}</span>
                </div>
                {o.rideClass ? <p className="mc-muted text-xs pt-1">Class: {o.rideClass}</p> : null}
              </div>
            ) : (
              <div className="space-y-2">
                {(o.items ?? []).map((it: any) => (
                  <div key={it.id} className="flex items-start justify-between p-3 rounded-lg bg-[var(--mc-surface)] text-sm">
                    <div>
                      <p>
                        {it.quantity}× {it.name}
                      </p>
                      {(it.selectedOptions ?? []).length > 0 && (
                        <p className="text-xs mc-muted mt-0.5">
                          {(it.selectedOptions ?? []).map((op: any) => op.optionName ?? op.name).filter(Boolean).join(', ')}
                        </p>
                      )}
                      {it.specialInstructions ? (
                        <p className="text-xs mc-text-warn mt-0.5">“{it.specialInstructions}”</p>
                      ) : null}
                    </div>
                    <span className="font-medium">{gyd(it.totalCustomer)}</span>
                  </div>
                ))}
                {(o.items ?? []).length === 0 && <p className="text-sm mc-muted">No items.</p>}
              </div>
            )}
          </Section>

          <Section title="Timeline">
            {timeline.length === 0 ? (
              <p className="text-sm mc-muted">No events recorded.</p>
            ) : (
              <div className="space-y-0">
                {timeline.map((ev: any, i: number) => (
                  <div key={ev.id ?? i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={`w-2.5 h-2.5 rounded-full mt-1 ${i === 0 ? 'bg-[var(--mc-accent)]' : 'bg-[var(--mc-line-strong)]'}`} />
                      {i < timeline.length - 1 && <span className="w-px flex-1 bg-[var(--mc-line-strong)]" />}
                    </div>
                    <div className={`pb-4 ${i === 0 ? '' : 'opacity-80'}`}>
                      <p className="text-sm font-medium">{label('OrderStatus', ev.status)}</p>
                      {ev.note ? <p className="text-xs mc-muted mt-0.5">{ev.note}</p> : null}
                      <p className="text-xs mc-muted mt-0.5">{gyDateTime(ev.createdAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* Right column — people + money */}
        <div className="space-y-4">
          <Section title="People">
            <div className="space-y-2">
              <Party
                label="Customer"
                name={[o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || null}
                phone={o.customer?.phone}
                revealed={revealed.customer}
                onReveal={revealFor('customer', 'customer')}
              />
              <Party label="Vendor" name={o.vendor?.name} phone={o.vendor?.phone} revealed={revealed.store} onReveal={revealFor('store', 'store')} />
              <Party
                label={moverLabel ?? 'Mover'}
                name={mover ? [mover.firstName, mover.lastName].filter(Boolean).join(' ') : null}
                phone={mover?.phone}
                revealed={revealed.mover}
                onReveal={revealFor('mover', (moverLabel ?? 'mover').toLowerCase())}
              />
              {!o.vendor && !mover && !o.customer && <p className="text-sm mc-muted">—</p>}
            </div>
          </Section>

          <Section title="Money">
            <div className="space-y-1.5 text-sm">
              {!isRide && (
                <div className="flex justify-between">
                  <span className="mc-muted">Subtotal</span>
                  <span>{gyd(o.subtotalCustomer ?? o.subtotalBase)}</span>
                </div>
              )}
              {Number(o.deliveryFee) > 0 && (
                <div className="flex justify-between">
                  <span className="mc-muted">Delivery fee</span>
                  <span>{gyd(o.deliveryFee)}</span>
                </div>
              )}
              {Number(o.tipAmount) > 0 && (
                <div className="flex justify-between">
                  <span className="mc-muted">Tip</span>
                  <span>{gyd(o.tipAmount)}</span>
                </div>
              )}
              {Number(o.discount) > 0 && (
                <div className="flex justify-between">
                  <span className="mc-muted">Discount{o.promoCode?.code ? ` (${o.promoCode.code})` : ''}</span>
                  <span>-{gyd(o.discount)}</span>
                </div>
              )}
              {/* [TAXI waiting charge] A ride charged for waiting: the frozen line, read-only. */}
              {waiting && (
                <>
                  <div className="flex justify-between">
                    <span className="mc-muted">Trip fare</span>
                    <span>{gyd(waiting.routeFare)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="mc-muted">Waiting ({waiting.waitingMinutes} min)</span>
                    <span>{gyd(waiting.waitingCharge)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between pt-2 mt-1 border-t border-[var(--mc-line)] font-semibold">
                <span>Total</span>
                <span>{gyd(waiting ? waiting.total : isRide ? (o.taxiFareTotal ?? o.totalAmount) : o.totalAmount)}</span>
              </div>
              <p className="text-xs mc-muted pt-1">
                {isMmg ? 'Paid to the vendor’s MMG account — Swift moves no money.' : 'Cash at handover — Swift moves no money.'}
              </p>
            </div>
          </Section>

          <Section title="Details">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="mc-muted">Placed</span>
                <span>{o.placedAt ? gyDateTime(o.placedAt) : '—'}</span>
              </div>
              {o.deliveredAt && (
                <div className="flex justify-between">
                  <span className="mc-muted">Delivered</span>
                  <span>{gyDateTime(o.deliveredAt)}</span>
                </div>
              )}
              {o.fulfillment && (
                <div className="flex justify-between">
                  <span className="mc-muted">Fulfillment</span>
                  <span>{o.fulfillment}</span>
                </div>
              )}
              {/* [A-15] The pickup code is a credential: the customer holds it, the
                  vendor types what the customer reads out, the server compares. It is
                  not in this response and not on this screen. What an operator needs
                  to answer a support call is whether a code exists and whether the
                  order has been locked out by wrong guesses. */}
              {o.handover?.pickupCodeIssued && (
                <div className="flex justify-between">
                  <span className="mc-muted">Pickup code</span>
                  <span className={o.handover.locked ? 'mc-text-bad' : ''}>
                    {o.handover.locked
                      ? `Locked — ${o.handover.attempts} wrong tries`
                      : `Issued to the customer${o.handover.attempts > 0 ? ` · ${o.handover.attempts} wrong tries` : ''}`}
                  </span>
                </div>
              )}
              {/* [MKT-F057] The delivery PIN: the customer holds it, the rider enters it at
                  the door. Same rule as the pickup code: never the value, only whether it
                  exists and whether wrong tries have locked the door (support reset). */}
              {o.handover?.ridePinIssued && !isRide && (
                <div className="flex justify-between">
                  <span className="mc-muted">Delivery PIN</span>
                  <span className={o.handover.ridePinLocked ? 'mc-text-bad' : ''}>
                    {o.handover.ridePinLocked
                      ? `Locked — ${o.handover.ridePinAttempts} wrong tries (support reset)`
                      : `Issued to the customer${(o.handover.ridePinAttempts ?? 0) > 0 ? ` · ${o.handover.ridePinAttempts} wrong tries` : ''}`}
                  </span>
                </div>
              )}
              {o.deliveryAddress && !isRide && (
                <div className="flex justify-between gap-4">
                  <span className="mc-muted shrink-0">Address</span>
                  <span className="text-right">{o.deliveryAddress}</span>
                </div>
              )}
              {o.cancellationReason && (
                <div className="flex justify-between gap-4">
                  <span className="mc-muted shrink-0">Cancelled</span>
                  <span className="text-right mc-text-bad">{o.cancellationReason}</span>
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
