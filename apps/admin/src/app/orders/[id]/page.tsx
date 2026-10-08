'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Phone } from 'lucide-react';
import { fetchOrderDetail, cancelOrder, settleOrderRefund, errorStatus } from '@/lib/api';
import { statusClass } from '@/lib/status';
import { useActionRunner } from '@/components/mc/useActionRunner';
import { QueryFailed } from '@/components/mc/QueryFailed';

const gyd = (n: unknown) => `$${Number(n || 0).toLocaleString()}`;
const TERMINAL = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--panel)] rounded-xl border border-[var(--border)] p-6">
      <h2 className="text-sm font-semibold text-[var(--muted)] tracking-widest mb-4">{title.toUpperCase()}</h2>
      {children}
    </div>
  );
}

function Party({ label, name, phone, href }: { label: string; name?: string | null; phone?: string | null; href?: string }) {
  if (!name) return null;
  return (
    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
      <div>
        <p className="text-xs text-[var(--muted)]">{label}</p>
        {href ? (
          <Link href={href} className="text-sm font-medium hover:text-[var(--accent)] transition-colors">
            {name}
          </Link>
        ) : (
          <p className="text-sm font-medium">{name}</p>
        )}
      </div>
      {phone ? (
        <a href={`tel:${phone}`} className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-white">
          <Phone size={13} />
          {phone}
        </a>
      ) : null}
    </div>
  );
}

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({ queryKey: ['order', id], queryFn: () => fetchOrderDetail(id) });
  // [MC-MONEY] Cancelling, recording a refund owed and settling it are each one
  // in-page panel ([ADM-006] the operator's words, not a template); the
  // server's answer — done, sent for a second admin's approval, or refused —
  // stays on screen.
  const actions = useActionRunner(() => {
    void queryClient.invalidateQueries({ queryKey: ['order', id] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  });

  const o: any = data?.data;

  if (isLoading) {
    return <div className="h-40 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />;
  }
  if (isError || !o) {
    // [DS768 D3] Only a 404 is "not found"; an outage is a failed read with a Retry.
    const missing = !isError || errorStatus(error) === 404;
    return (
      <div>
        <Link href="/orders" className="inline-flex items-center gap-2 text-sm text-[var(--muted)] hover:text-white mb-4">
          <ArrowLeft size={16} /> Orders
        </Link>
        {missing
          ? <p className="text-[var(--muted)]">Order not found.</p>
          : <QueryFailed error={error} what="this order" onRetry={() => void refetch()} retrying={isFetching} />}
      </div>
    );
  }

  const isRide = o.orderType === 'TAXI';
  const mover = o.rider?.user ?? o.driver?.user;
  const moverLabel = o.rider ? 'Rider' : o.driver ? 'Driver' : null;
  const isMmg = o.paymentMethod === 'MOBILE_MONEY';
  const refundingStore = o.vendor?.name ?? 'the store';
  const timeline: any[] = o.statusHistory ?? [];

  const cancel = (refund: boolean) => void actions.run({
    title: refund ? `Cancel order ${o.orderNumber} and record a refund owed?` : `Cancel order ${o.orderNumber}?`,
    body: refund ? (
      <p>
        This records that {refundingStore} OWES the customer a refund. It does not mark anything refunded — the order
        stays in the outstanding list until someone records the reference and the amount actually handed back.
      </p>
    ) : isMmg ? (
      <p>MMG payment stays between customer and store. If paid, it is refunded by {refundingStore}; Swift cannot refund it.</p>
    ) : (
      <p>The customer and {refundingStore} are told the order is cancelled.</p>
    ),
    confirmLabel: refund ? 'Cancel and record refund owed' : 'Cancel order',
    reason: { hint: 'The customer is owed the real reason; it is kept on the permanent record.' },
    submit: ({ reason }) => cancelOrder(id, { refund }, reason),
    success: () => (refund ? `Order ${o.orderNumber} is cancelled; ${refundingStore} owes the customer a refund.` : `Order ${o.orderNumber} is cancelled.`),
  });
  // [A-14] Closing a refund is a separate act from deciding one is owed, and it
  // needs what a refund actually is: a reference and the amount handed back.
  const settleRefund = () => void actions.run({
    title: `Record the refund handed back for order ${o.orderNumber}?`,
    body: <p>The order owes GY${Number(o.refundOwedAmount ?? 0).toLocaleString()}. Record what was actually handed back; the server checks it against what is owed.</p>,
    confirmLabel: 'Record refund',
    fields: [
      { kind: 'reference', name: 'reference', label: 'Reference', hint: 'Receipt or handover number' },
      { kind: 'amount', name: 'amount', label: 'Amount handed back', hint: 'In GYD, as handed back', cents: true },
    ],
    submit: ({ reason, values }) => settleOrderRefund(id, String(values['reference']), Number(values['amount']), reason),
    success: () => `The refund for order ${o.orderNumber} is recorded as handed back.`,
  });

  return (
    <div>
      <Link href="/orders" className="inline-flex items-center gap-2 text-sm text-[var(--muted)] hover:text-white mb-4">
        <ArrowLeft size={16} /> Orders
      </Link>

      {/* Header — identity + the actions an operator actually has */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold font-mono">#{o.orderNumber}</h1>
        <span className={`px-2.5 py-1 rounded-full text-xs ${statusClass(o.status)}`}>{o.status}</span>
        <span className="px-2.5 py-1 rounded-full text-xs bg-white/10 text-[var(--muted)]">
          {String(o.orderType).replaceAll('_', ' ').toLowerCase()}
        </span>
        {isMmg ? (
          o.paymentStatus === 'CAPTURED' ? (
            <span className="px-2.5 py-1 rounded-full text-xs bg-emerald-500/15 text-emerald-400">MMG paid</span>
          ) : (
            <span className="px-2.5 py-1 rounded-full text-xs bg-amber-500/15 text-amber-400">MMG awaiting confirmation</span>
          )
        ) : (
          <span className="px-2.5 py-1 rounded-full text-xs bg-white/10 text-[var(--muted)]">cash</span>
        )}
        <div className="ml-auto flex gap-2">
          {!TERMINAL.includes(o.status) && (
            <>
              <button
                onClick={() => cancel(false)}
                className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
              >
                Cancel order…
              </button>
              {o.paymentMethod === 'CASH' && (
                <button
                  onClick={() => cancel(true)}
                  className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                >
                  Record refund owed…
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {actions.banner}

      {/* [A-14] An obligation nobody has settled is money the customer is still
          waiting for. It says so, with its age, until evidence closes it. */}
      {o.refundOwedAt && !o.refundSettledAt && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="text-sm text-amber-300 font-medium">Refund owed — not yet settled</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            GY${Number(o.refundOwedAmount ?? 0).toLocaleString()} recorded as owed on{' '}
            {new Date(o.refundOwedAt).toLocaleString()}. Nothing here says the money moved.
          </p>
          <button
            onClick={settleRefund}
            className="mt-3 px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
          >
            Record refund handed back…
          </button>
        </div>
      )}

      {o.refundSettledAt && (
        <div className="rounded-xl border border-[var(--border)] p-4">
          <p className="text-sm font-medium">Refund settled</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            GY${Number(o.refundPaidAmount ?? 0).toLocaleString()} — reference {o.refundRef} —{' '}
            {new Date(o.refundSettledAt).toLocaleString()}
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
                  <span className="w-2.5 h-2.5 rounded-full border-2 border-[var(--muted)]" />
                  <span>{o.pickupAddress ?? '—'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm bg-[var(--accent)]" />
                  <span>{o.deliveryAddress ?? '—'}</span>
                </div>
                {o.rideClass ? <p className="text-[var(--muted)] text-xs pt-1">Class: {o.rideClass}</p> : null}
              </div>
            ) : (
              <div className="space-y-2">
                {(o.items ?? []).map((it: any) => (
                  <div key={it.id} className="flex items-start justify-between p-3 rounded-lg bg-white/5 text-sm">
                    <div>
                      <p>
                        {it.quantity}× {it.name}
                      </p>
                      {(it.selectedOptions ?? []).length > 0 && (
                        <p className="text-xs text-[var(--muted)] mt-0.5">
                          {(it.selectedOptions ?? []).map((op: any) => op.optionName ?? op.name).filter(Boolean).join(', ')}
                        </p>
                      )}
                      {it.specialInstructions ? (
                        <p className="text-xs text-amber-400/90 mt-0.5">“{it.specialInstructions}”</p>
                      ) : null}
                    </div>
                    <span className="font-medium">{gyd(it.totalCustomer)}</span>
                  </div>
                ))}
                {(o.items ?? []).length === 0 && <p className="text-sm text-[var(--muted)]">No items.</p>}
              </div>
            )}
          </Section>

          <Section title="Timeline">
            {timeline.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No events recorded.</p>
            ) : (
              <div className="space-y-0">
                {timeline.map((ev: any, i: number) => (
                  <div key={ev.id ?? i} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={`w-2.5 h-2.5 rounded-full mt-1 ${i === 0 ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'}`} />
                      {i < timeline.length - 1 && <span className="w-px flex-1 bg-[var(--border)]" />}
                    </div>
                    <div className={`pb-4 ${i === 0 ? '' : 'opacity-80'}`}>
                      <p className="text-sm font-medium">{String(ev.status).replaceAll('_', ' ')}</p>
                      {ev.note ? <p className="text-xs text-[var(--muted)] mt-0.5">{ev.note}</p> : null}
                      <p className="text-xs text-[var(--muted)]/70 mt-0.5">{new Date(ev.createdAt).toLocaleString()}</p>
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
              />
              <Party label="Vendor" name={o.vendor?.name} phone={o.vendor?.phone} />
              <Party
                label={moverLabel ?? 'Mover'}
                name={mover ? [mover.firstName, mover.lastName].filter(Boolean).join(' ') : null}
                phone={mover?.phone}
              />
              {!o.vendor && !mover && !o.customer && <p className="text-sm text-[var(--muted)]">—</p>}
            </div>
          </Section>

          <Section title="Money">
            <div className="space-y-1.5 text-sm">
              {!isRide && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted)]">Subtotal</span>
                  <span>{gyd(o.subtotalCustomer ?? o.subtotalBase)}</span>
                </div>
              )}
              {Number(o.deliveryFee) > 0 && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted)]">Delivery fee</span>
                  <span>{gyd(o.deliveryFee)}</span>
                </div>
              )}
              {Number(o.tipAmount) > 0 && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted)]">Tip</span>
                  <span>{gyd(o.tipAmount)}</span>
                </div>
              )}
              {Number(o.discount) > 0 && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted)]">Discount{o.promoCode?.code ? ` (${o.promoCode.code})` : ''}</span>
                  <span>-{gyd(o.discount)}</span>
                </div>
              )}
              <div className="flex justify-between pt-2 mt-1 border-t border-[var(--border)] font-semibold">
                <span>Total</span>
                <span>{gyd(isRide ? (o.taxiFareTotal ?? o.totalAmount) : o.totalAmount)}</span>
              </div>
              <p className="text-xs text-[var(--muted)] pt-1">
                {isMmg ? 'Paid to the vendor’s MMG wallet — Swift moves no money.' : 'Cash at handover — Swift moves no money.'}
              </p>
            </div>
          </Section>

          <Section title="Details">
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">Placed</span>
                <span>{o.placedAt ? new Date(o.placedAt).toLocaleString() : '—'}</span>
              </div>
              {o.deliveredAt && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted)]">Delivered</span>
                  <span>{new Date(o.deliveredAt).toLocaleString()}</span>
                </div>
              )}
              {o.fulfillment && (
                <div className="flex justify-between">
                  <span className="text-[var(--muted)]">Fulfillment</span>
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
                  <span className="text-[var(--muted)]">Pickup code</span>
                  <span className={o.handover.locked ? 'text-[var(--danger)]' : ''}>
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
                  <span className="text-[var(--muted)]">Delivery PIN</span>
                  <span className={o.handover.ridePinLocked ? 'text-[var(--danger)]' : ''}>
                    {o.handover.ridePinLocked
                      ? `Locked — ${o.handover.ridePinAttempts} wrong tries (support reset)`
                      : `Issued to the customer${(o.handover.ridePinAttempts ?? 0) > 0 ? ` · ${o.handover.ridePinAttempts} wrong tries` : ''}`}
                  </span>
                </div>
              )}
              {o.deliveryAddress && !isRide && (
                <div className="flex justify-between gap-4">
                  <span className="text-[var(--muted)] shrink-0">Address</span>
                  <span className="text-right">{o.deliveryAddress}</span>
                </div>
              )}
              {o.cancellationReason && (
                <div className="flex justify-between gap-4">
                  <span className="text-[var(--muted)] shrink-0">Cancelled</span>
                  <span className="text-right text-red-400">{o.cancellationReason}</span>
                </div>
              )}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
