'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { acceptOrder, money, rejectOrder, type VendorOrder } from '@/lib/vendor-api';
import { rejectReasonsFor } from '@/lib/reject-reasons';
import { formatAppointmentSlot } from '@/lib/appointmentTime';

/**
 * The NEW-ORDER takeover (alerts spec §A1, web dashboard flavor): the moment
 * the queue poll reveals unseen PENDING orders, a full-screen overlay renders
 * with giant Accept/Reject — nothing else is clickable until acknowledged.
 * A synthesized chime repeats every 5s (Web Audio — no asset needed) and the
 * tab title flashes for the backgrounded-tab case. "View later" dismisses
 * honestly (the escalation ladder + acceptance guard still stand behind it).
 */

function chime(ctx: AudioContext) {
  // Two quick rising tones — unmistakably "new money", no file required.
  const at = ctx.currentTime;
  for (const [freq, start] of [[880, 0], [1174.66, 0.18]] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.0001, at + start);
    gain.gain.exponentialRampToValueAtTime(0.35, at + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + start + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at + start);
    osc.stop(at + start + 0.4);
  }
}

export default function NewOrderTakeover({ orders }: { orders: VendorOrder[] }) {
  const queryClient = useQueryClient();
  const [seen, setSeen] = useState<Set<string> | null>(null); // null until first poll
  const [queue, setQueue] = useState<VendorOrder[]>([]);
  const [prepTime, setPrepTime] = useState(20);
  // [E10] The API requires a reason on every rejection. The mobile takeover
  // collects one of the same three presets; a non-empty default keeps Reject
  // a single tap while still satisfying the contract.
  const [rejectReason, setRejectReason] = useState('Out of stock');
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const titleRef = useRef<string | null>(null);
  const currentBooking = queue[0]?.fulfillment === 'APPOINTMENT';

  // Detect unseen PENDING orders between polls. The FIRST poll only baselines —
  // a dashboard opened onto an old queue must not scream about stale orders.
  useEffect(() => {
    const pending = orders.filter((o) => (o.status || '').toUpperCase() === 'PENDING');
    if (seen === null) {
      setSeen(new Set(pending.map((o) => o.id)));
      return;
    }
    const fresh = pending.filter((o) => !seen.has(o.id));
    if (fresh.length > 0) {
      setSeen(new Set([...seen, ...fresh.map((o) => o.id)]));
      setQueue((q) => [...q, ...fresh.filter((f) => !q.some((x) => x.id === f.id))]);
    }
  }, [orders, seen]);

  // [Q12] A queued order the latest poll shows is no longer PENDING — the
  // customer cancelled it, another device answered it, the no-response timer
  // reaped it — leaves the takeover: the chime is for an open decision.
  useEffect(() => {
    const settled = new Set(orders.filter((o) => (o.status || '').toUpperCase() !== 'PENDING').map((o) => o.id));
    if (settled.size === 0) return;
    setQueue((q) => (q.some((o) => settled.has(o.id)) ? q.filter((o) => !settled.has(o.id)) : q));
  }, [orders]);

  // Chime + tab flash while the takeover is up.
  useEffect(() => {
    if (queue.length === 0) return;
    audioRef.current ??= new AudioContext();
    const ctx = audioRef.current;
    chime(ctx);
    const soundTimer = setInterval(() => chime(ctx), 5000);

    titleRef.current ??= document.title;
    let flash = false;
    const titleTimer = setInterval(() => {
      flash = !flash;
      document.title = flash ? `(${queue.length}) NEW ${currentBooking ? 'BOOKING' : 'ORDER'} — Swift` : titleRef.current!;
    }, 1000);

    return () => {
      clearInterval(soundTimer);
      clearInterval(titleTimer);
      if (titleRef.current) document.title = titleRef.current;
    };
  }, [queue.length, currentBooking]);

  const done = (id: string) => {
    setQueue((q) => q.filter((o) => o.id !== id));
    setError(null);
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const accept = useMutation({
    mutationFn: (id: string) => acceptOrder(id, queue.find((o) => o.id === id)?.fulfillment === 'APPOINTMENT' ? undefined : prepTime),
    onSuccess: (_r, id) => done(id),
    onError: (e) => setError((e as Error).message),
  });
  const reject = useMutation({
    // The chosen preset, or the first one that fits this order when the
    // choice was made for a different kind (a booking after a food order).
    mutationFn: (id: string) => {
      const reasons = rejectReasonsFor(queue.find((o) => o.id === id)?.fulfillment);
      return rejectOrder(id, reasons.includes(rejectReason) ? rejectReason : reasons[0]!);
    },
    onSuccess: (_r, id) => done(id),
    onError: (e) => setError((e as Error).message),
  });

  const current = queue[0];
  if (!current) return null;
  const customer = [current.customer?.firstName, current.customer?.lastName].filter(Boolean).join(' ') || 'Customer';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/80 p-3 min-[400px]:p-6">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-4 text-center shadow-2xl min-[400px]:p-8">
        <p className="text-4xl">🔔</p>
        <h2 className="mt-2 text-3xl font-extrabold text-[var(--swift-red)]">
          {current.fulfillment === 'APPOINTMENT' ? 'NEW BOOKING' : queue.length > 1 ? `${queue.length} NEW ORDERS` : 'NEW ORDER'}
        </h2>
        <p className="mt-3 text-lg font-bold">
          #{current.orderNumber} · {money(current.totalAmount)}
        </p>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          {customer} · {current.items.length} item{current.items.length === 1 ? '' : 's'} ·{' '}
          {current.fulfillment === 'APPOINTMENT' ? 'appointment' : current.fulfillment === 'PICKUP' ? 'pickup' : 'delivery'}
        </p>
        {current.fulfillment === 'APPOINTMENT' && current.appointmentSlot ? <p className="mt-2 font-semibold">{formatAppointmentSlot(current.appointmentSlot)}</p> : null}
        <div className="mx-auto mt-3 max-h-32 max-w-sm overflow-auto text-left text-sm">
          {current.items.map((i) => (
            <p key={i.id} className="text-[var(--swift-muted)]">
              {i.quantity}× {i.name}
            </p>
          ))}
        </div>

        <div className="mt-5 flex flex-col items-stretch gap-2 min-[400px]:flex-row min-[400px]:items-center min-[400px]:justify-center">
          {current.fulfillment !== 'APPOINTMENT' && <select
            value={prepTime}
            onChange={(e) => setPrepTime(Number(e.target.value))}
            aria-label="Preparation time"
            className="min-h-11 w-full min-w-0 rounded-lg border border-black/10 px-2 py-3 text-sm min-[400px]:w-auto"
          >
            {[10, 15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>{m} min prep</option>
            ))}
          </select>}
          <button
            onClick={() => accept.mutate(current.id)}
            disabled={accept.isPending || reject.isPending}
            className="min-h-11 w-full rounded-xl bg-green-600 px-8 py-3 text-lg font-extrabold text-white disabled:opacity-50 min-[400px]:w-auto"
          >
            Accept
          </button>
          <select
            value={rejectReasonsFor(current.fulfillment).includes(rejectReason) ? rejectReason : rejectReasonsFor(current.fulfillment)[0]}
            onChange={(e) => setRejectReason(e.target.value)}
            aria-label="Reject reason"
            className="min-h-11 w-full min-w-0 rounded-lg border border-black/10 px-2 py-3 text-sm min-[400px]:w-auto"
          >
            {rejectReasonsFor(current.fulfillment).map((why) => (
              <option key={why} value={why}>{why}</option>
            ))}
          </select>
          <button
            onClick={() => reject.mutate(current.id)}
            disabled={accept.isPending || reject.isPending}
            className="min-h-11 w-full rounded-xl border-2 border-[var(--swift-red)] px-6 py-3 text-lg font-bold text-[var(--swift-red)] disabled:opacity-50 min-[400px]:w-auto"
          >
            {current.fulfillment === 'APPOINTMENT' ? 'Decline' : 'Reject'}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-[var(--swift-red)]">{error}</p>}
        <button
          onClick={() => done(current.id)}
          className="mt-4 text-xs text-[var(--swift-muted)] underline"
        >
          View later (the {current.fulfillment === 'APPOINTMENT' ? 'booking' : 'order'} stays in your queue)
        </button>
      </div>
    </div>
  );
}
