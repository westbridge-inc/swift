'use client';

import { use } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Phone } from 'lucide-react';
import { fetchOrderDetail, cancelOrder } from '@/lib/api';
import { statusClass } from '@/lib/status';
import { MutationError } from '@/components/MutationError';

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
  const { data, isLoading, isError } = useQuery({ queryKey: ['order', id], queryFn: () => fetchOrderDetail(id) });
  const cancelMutation = useMutation({
    mutationFn: ({ refund }: { refund: boolean }) => cancelOrder(id, { reason: 'Cancelled by admin', refund }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const o: any = data?.data;

  if (isLoading) {
    return <div className="h-40 rounded-xl bg-[var(--panel)] border border-[var(--border)] animate-pulse" />;
  }
  if (isError || !o) {
    return (
      <div>
        <Link href="/orders" className="inline-flex items-center gap-2 text-sm text-[var(--muted)] hover:text-white mb-4">
          <ArrowLeft size={16} /> Orders
        </Link>
        <p className="text-[var(--muted)]">Order not found.</p>
      </div>
    );
  }

  const isRide = o.orderType === 'TAXI';
  const mover = o.rider?.user ?? o.driver?.user;
  const moverLabel = o.rider ? 'Rider' : o.driver ? 'Driver' : null;
  const isMmg = o.paymentMethod === 'MOBILE_MONEY';
  const refundingStore = o.vendor?.name ?? 'the store';
  const timeline: any[] = o.statusHistory ?? [];

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
                onClick={() => {
                  const mmgNote = isMmg
                    ? `\n\nMMG payment stays between customer and store. If paid, it is refunded by ${refundingStore}; Swift cannot refund it.`
                    : '';
                  if (window.confirm(`Cancel order ${o.orderNumber}?${mmgNote}`)) cancelMutation.mutate({ refund: false });
                }}
                disabled={cancelMutation.isPending}
                className="px-4 py-2 rounded-lg text-sm border border-[var(--border)] hover:bg-white/10 disabled:opacity-50"
              >
                Cancel order
              </button>
              {o.paymentMethod === 'CASH' && (
                <button
                  onClick={() => {
                    if (window.confirm(`Cancel ${o.orderNumber} and record cash as refunded by ${refundingStore}?`)) {
                      cancelMutation.mutate({ refund: true });
                    }
                  }}
                  disabled={cancelMutation.isPending}
                  className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent)]/80 disabled:opacity-50"
                >
                  Record store refund
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {cancelMutation.error && (
        <div className="mb-4">
          <MutationError error={cancelMutation.error} label="Order cancellation failed" />
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
