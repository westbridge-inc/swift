'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { acceptOrder, money, rejectOrder, type VendorOrder } from '@/lib/vendor-api';

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
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const titleRef = useRef<string | null>(null);

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
      document.title = flash ? `(${queue.length}) NEW ORDER — Swift` : titleRef.current!;
    }, 1000);

    return () => {
      clearInterval(soundTimer);
      clearInterval(titleTimer);
      if (titleRef.current) document.title = titleRef.current;
    };
  }, [queue.length]);

  const done = (id: string) => {
    setQueue((q) => q.filter((o) => o.id !== id));
    setError(null);
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const accept = useMutation({
    mutationFn: (id: string) => acceptOrder(id, prepTime),
    onSuccess: (_r, id) => done(id),
    onError: (e) => setError((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: (id: string) => rejectOrder(id),
    onSuccess: (_r, id) => done(id),
    onError: (e) => setError((e as Error).message),
  });

  const current = queue[0];
  if (!current) return null;
  const customer = [current.customer?.firstName, current.customer?.lastName].filter(Boolean).join(' ') || 'Customer';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6">
      <div className="w-full max-w-lg rounded-3xl bg-white p-8 text-center shadow-2xl">
        <p className="text-4xl">🔔</p>
        <h2 className="mt-2 text-3xl font-extrabold text-[var(--swift-red)]">
          {queue.length > 1 ? `${queue.length} NEW ORDERS` : 'NEW ORDER'}
        </h2>
        <p className="mt-3 text-lg font-bold">
          #{current.orderNumber} · {money(current.totalAmount)}
        </p>
        <p className="mt-1 text-sm text-[var(--swift-muted)]">
          {customer} · {current.items.length} item{current.items.length === 1 ? '' : 's'} ·{' '}
          {current.fulfillment === 'PICKUP' ? 'pickup' : 'delivery'}
        </p>
        <div className="mx-auto mt-3 max-h-32 max-w-sm overflow-auto text-left text-sm">
          {current.items.map((i) => (
            <p key={i.id} className="text-[var(--swift-muted)]">
              {i.quantity}× {i.name}
            </p>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-center gap-2">
          <select
            value={prepTime}
            onChange={(e) => setPrepTime(Number(e.target.value))}
            className="rounded-lg border border-black/10 px-2 py-3 text-sm"
          >
            {[10, 15, 20, 30, 45, 60].map((m) => (
              <option key={m} value={m}>{m} min prep</option>
            ))}
          </select>
          <button
            onClick={() => accept.mutate(current.id)}
            disabled={accept.isPending || reject.isPending}
            className="rounded-xl bg-green-600 px-8 py-3 text-lg font-extrabold text-white disabled:opacity-50"
          >
            Accept
          </button>
          <button
            onClick={() => reject.mutate(current.id)}
            disabled={accept.isPending || reject.isPending}
            className="rounded-xl border-2 border-[var(--swift-red)] px-6 py-3 text-lg font-bold text-[var(--swift-red)] disabled:opacity-50"
          >
            Reject
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-[var(--swift-red)]">{error}</p>}
        <button
          onClick={() => done(current.id)}
          className="mt-4 text-xs text-[var(--swift-muted)] underline"
        >
          View later (the order stays in your queue)
        </button>
      </div>
    </div>
  );
}
