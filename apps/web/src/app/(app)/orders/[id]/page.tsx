'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { getOrder, cancelOrder, money } from '@/lib/customer';

const STEPS = ['PENDING', 'ACCEPTED', 'PREPARING', 'RIDER_ASSIGNED', 'PICKED_UP', 'DELIVERED'];
const STEP_LABEL = ['Placed', 'Accepted', 'Preparing', 'Rider assigned', 'Picked up', 'Delivered'];

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [o, setO] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => { try { setO(await getOrder(id)); } catch (e: any) { setError(e.message); } }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000); // live-ish tracking
    return () => clearInterval(t);
  }, [load]);

  if (error) return <p className="text-[var(--swift-muted)]">{error}</p>;
  if (!o) return <div className="h-64 animate-pulse rounded-2xl bg-[var(--swift-subtle)]" />;

  const cancelled = o.status === 'CANCELLED';
  const idx = STEPS.indexOf(o.status);
  const isPickup = o.fulfillment === 'PICKUP';

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="rounded-2xl border border-black/5 bg-white p-5 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-[var(--swift-red)]" />
        <h1 className="mt-2 text-xl font-extrabold">Order placed</h1>
        <p className="text-[var(--swift-muted)]">{o.vendorName ?? o.vendor?.name} · {o.orderNumber}</p>
        {o.pickupCode && <p className="mt-2 text-sm">Pickup code: <span className="font-bold tracking-widest">{o.pickupCode}</span></p>}
      </div>

      {!cancelled && !isPickup && idx >= 0 && (
        <div className="rounded-2xl border border-black/5 bg-white p-5">
          <ol className="space-y-3">
            {STEPS.slice(0, 6).map((s, i) => (
              <li key={s} className="flex items-center gap-3">
                <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${i <= idx ? 'bg-[var(--swift-red)] text-white' : 'bg-[var(--swift-subtle)] text-[var(--swift-muted)]'}`}>{i < idx ? '✓' : i + 1}</span>
                <span className={i <= idx ? 'font-semibold' : 'text-[var(--swift-muted)]'}>{STEP_LABEL[i]}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {cancelled && <p className="rounded-2xl border border-dashed border-black/10 p-4 text-center font-semibold text-[var(--swift-red)]">This order was cancelled.</p>}

      <div className="rounded-2xl border border-black/5 bg-white p-5">
        <p className="mb-2 font-bold">Order</p>
        {(o.items ?? []).map((it: any, i: number) => (
          <div key={i} className="flex justify-between py-1 text-sm"><span>{it.quantity}× {it.name}</span><span className="font-semibold">{money(it.lineTotal ?? it.price ?? 0)}</span></div>
        ))}
        <div className="mt-2 flex justify-between border-t border-black/5 pt-2 font-extrabold"><span>Total</span><span>{money(o.totalAmount ?? o.total ?? 0)}</span></div>
        <p className="mt-2 text-xs text-[var(--swift-muted)]">{o.paymentMethod === 'MOBILE_MONEY' ? 'Pay the business via MMG' : 'Cash on delivery'} · {o.deliveryAddress}</p>
      </div>

      {['PENDING'].includes(o.status) && (
        <button onClick={async () => { await cancelOrder(id, 'changed my mind').then(load).catch((e) => setError(e.message)); }} className="w-full rounded-full border border-[var(--swift-red)] py-2.5 font-bold text-[var(--swift-red)]">Cancel order</button>
      )}
      <Link href="/orders" className="block text-center text-sm font-semibold text-[var(--swift-muted)]">All orders</Link>
    </div>
  );
}
