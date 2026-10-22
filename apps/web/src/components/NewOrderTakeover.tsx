'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { acceptOrder, money, rejectOrder, type VendorOrder } from '@/lib/vendor-api';
import { rejectReasonsFor } from '@/lib/reject-reasons';
// The app's own clock wording (plain file, imported as is).
import { acceptClockLabel } from '../../../mobile/src/modules/vendor/acceptClock';
import { formatAppointmentSlot } from '@/lib/appointmentTime';
import { acceptHeldForPayment, mmgPayBlockedReason } from '@/lib/mmg-pay-words';
import { canAttestPayment } from '@/lib/vendor-hub';
import { mmgDisputePaused } from '@/lib/mmg-dispute';
import { storeKey, useStoreId } from '@/lib/store-scope';
import { focusableIn } from '@/components/modal';

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

/** [STORE-DASH] PENDING, not paused, and its answer clock (if the server sent one) still running. */
function stillWaiting(o: VendorOrder): boolean {
  if ((o.status || '').toUpperCase() !== 'PENDING' || mmgDisputePaused(o)) return false;
  const by = o.respondBy ? Date.parse(o.respondBy) : NaN;
  return !Number.isFinite(by) || by > Date.now();
}

/** The page's one sound context, made on first need; null where the browser has none. */
function audioContext(ref: { current: AudioContext | null }): AudioContext | null {
  if (ref.current) return ref.current;
  if (typeof AudioContext === 'undefined') return null;
  try { ref.current = new AudioContext(); } catch { return null; }
  return ref.current;
}

export default function NewOrderTakeover({ orders, onOpenOrder }: { orders: VendorOrder[]; onOpenOrder?: (_id: string) => void }) {
  const queryClient = useQueryClient();
  const storeId = useStoreId();
  const [seen, setSeen] = useState<Set<string> | null>(null); // null until first poll
  const [queue, setQueue] = useState<VendorOrder[]>([]);
  const [prepTime, setPrepTime] = useState(20);
  // [E10 · UI-SWEEP U21] The API requires a reason on every rejection, and a
  // rejection cannot be undone. The phone asks in two steps ("Reject — tell us
  // why", then the reason); one stray tap here used to reject with a
  // preselected reason. Now the first press only opens the reasons.
  const [rejecting, setRejecting] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const titleRef = useRef<string | null>(null);
  // [STORE-DASH] A browser keeps a page's sound off until the page is pressed
  // once (a reload starts silent). The takeover says so and offers the press.
  const [soundOff, setSoundOff] = useState(false);
  const currentBooking = queue[0]?.fulfillment === 'APPOINTMENT';
  // [STORE-DASH] Orders still waiting for an answer, for the tab title.
  const waiting = orders.filter(stillWaiting).length;

  // Detect unseen PENDING orders between polls. The FIRST poll only baselines —
  // a dashboard opened onto an old queue must not scream about stale orders.
  useEffect(() => {
    // [Item 10] A disputed MMG order is paused: nothing to accept, no chime.
    const pending = orders.filter((o) => (o.status || '').toUpperCase() === 'PENDING' && !mmgDisputePaused(o));
    if (seen === null) {
      // [STORE-DASH · owner 22 Oct "impossible to miss"] An order still waiting
      // for an answer when the page opens is an open decision, not an old one:
      // it takes the screen too. Only an order whose answer clock already ran
      // out (the server is closing it) stays quiet on the board.
      setSeen(new Set(pending.map((o) => o.id)));
      setQueue(pending.filter(stillWaiting));
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
    const settled = new Set(orders.filter((o) => (o.status || '').toUpperCase() !== 'PENDING' || mmgDisputePaused(o)).map((o) => o.id));
    if (settled.size === 0) return;
    setQueue((q) => (q.some((o) => settled.has(o.id)) ? q.filter((o) => !settled.has(o.id)) : q));
  }, [orders]);

  // [STORE-DASH] The page's first press or key wakes the sound, so the next
  // order is heard even after a reload.
  useEffect(() => {
    const wake = () => {
      const ctx = audioContext(audioRef);
      if (ctx?.state === 'suspended') void ctx.resume?.().catch(() => {});
    };
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  // Chime while the takeover is up.
  useEffect(() => {
    if (queue.length === 0) return;
    const ctx = audioContext(audioRef);
    if (!ctx) return;
    const blocked = () => setSoundOff(ctx.state === 'suspended');
    blocked();
    ctx.onstatechange = blocked;
    chime(ctx);
    const soundTimer = setInterval(() => chime(ctx), 5000);
    return () => {
      clearInterval(soundTimer);
      ctx.onstatechange = null;
    };
  }, [queue.length]);

  // The tab title: flashes while the takeover is up; afterwards it keeps the
  // count of orders still waiting (View later included), so a background tab
  // always says an order is waiting.
  useEffect(() => {
    titleRef.current ??= document.title;
    const base = titleRef.current;
    if (queue.length > 0) {
      let flash = false;
      const titleTimer = setInterval(() => {
        flash = !flash;
        document.title = flash ? `(${queue.length}) NEW ${currentBooking ? 'BOOKING' : 'ORDER'} — Swift` : base;
      }, 1000);
      return () => { clearInterval(titleTimer); document.title = base; };
    }
    if (waiting > 0) {
      document.title = `(${waiting}) ${waiting === 1 ? 'order waiting' : 'orders waiting'} — ${base}`;
      return () => { document.title = base; };
    }
    return undefined;
  }, [queue.length, currentBooking, waiting]);

  const done = (id: string) => {
    setQueue((q) => q.filter((o) => o.id !== id));
    setError(null);
    setRejecting(false);
    // [U48] The board's key is store-scoped: refresh THAT, or the decided order
    // sits under "New" until the next poll.
    queryClient.invalidateQueries({ queryKey: storeKey(storeId, 'orders') });
  };
  const accept = useMutation({
    mutationFn: (id: string) => acceptOrder(id, queue.find((o) => o.id === id)?.fulfillment === 'APPOINTMENT' ? undefined : prepTime),
    onSuccess: (_r, id) => done(id),
    onError: (e) => setError((e as Error).message),
  });
  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => rejectOrder(id, reason),
    onSuccess: (_r, { id }) => done(id),
    onError: (e) => setError((e as Error).message),
  });

  // The draining accept clock, as in the app: the server's own deadline
  // (`respondBy`), recomputed from the wall clock every second, and drawn only
  // while the decision is open.
  const head = queue[0];
  const respondByMs = head?.respondBy ? Date.parse(head.respondBy) : NaN;
  const clockOpen = (head?.status || '').toUpperCase() === 'PENDING' && Number.isFinite(respondByMs);
  const [nowTs, setNowTs] = useState(() => Date.now());
  // As in the app, the clock is drawn only until the deadline passes.
  const clockActive = clockOpen && respondByMs > nowTs;
  useEffect(() => {
    if (!clockOpen) return;
    setNowTs(Date.now());
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [clockOpen, respondByMs]);

  const current = queue[0];
  const currentId = current?.id;
  // A different order on top starts at the first step again.
  useEffect(() => { setRejecting(false); }, [currentId]);
  // The takeover is a modal dialog: focus moves into it, on Accept.
  useEffect(() => {
    if (!currentId) return;
    const before = document.activeElement as HTMLElement | null;
    acceptRef.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, [currentId]);
  // Tab and Shift+Tab stay inside. Escape is inert, as the phone's hardware
  // back is: leaving this order is a decision (Accept, Reject or View later),
  // and a reflex key press must not be one. It also never reaches the order
  // window underneath.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const inside = focusableIn(dialogRef.current);
    if (!inside.length) return;
    const first = inside[0]!;
    const last = inside[inside.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  };

  if (!current) return null;
  const remainSecs = clockActive ? Math.max(0, Math.ceil((respondByMs - nowTs) / 1000)) : 0;
  // Payment-first, the one rule every Accept on the web follows (lib/mmg-pay-words):
  // an unpaid MMG order offers the store's confirmation (in the order window), not Accept.
  const held = acceptHeldForPayment(current);
  const attestable = held && canAttestPayment(current.paymentStatus);
  const canConfirm = attestable && current.canConfirmPayment === true;
  const heldReason = held && !attestable ? mmgPayBlockedReason(current.paymentStatus) : null;
  const booking = current.fulfillment === 'APPOINTMENT';
  const busy = accept.isPending || reject.isPending;
  const customer = [current.customer?.firstName, current.customer?.lastName].filter(Boolean).join(' ') || 'Customer';

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="new-order-title"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/80 p-3 min-[400px]:p-6"
    >
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-4 text-center shadow-2xl min-[400px]:p-8">
        <BellRing aria-hidden="true" className="mx-auto h-10 w-10 text-[var(--swift-red)]" />
        {soundOff && (
          <button
            type="button"
            onClick={() => { const ctx = audioRef.current; if (ctx) void ctx.resume().then(() => chime(ctx)).catch(() => {}); }}
            className="mx-auto mt-2 flex min-h-11 items-center justify-center rounded-xl bg-[var(--swift-red)]/10 px-4 text-sm font-bold text-[var(--swift-red)]"
          >
            Sound is off — tap to hear new orders
          </button>
        )}
        <h2 id="new-order-title" className="mt-2 text-3xl font-extrabold text-[var(--swift-red)]">
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
        {clockActive && (
          <p className="mt-3 text-sm text-[var(--swift-muted)]">
            Accept within <b className="text-[var(--swift-ink)]">{acceptClockLabel(remainSecs)}</b> — the customer is watching this clock too.
          </p>
        )}

        {held && (
          <p className="mt-3 text-sm font-semibold text-[var(--swift-warning)]">
            {heldReason ?? 'Awaiting MMG payment'}
            {attestable && !canConfirm && <span className="mt-1 block font-normal text-[var(--swift-muted)]">Only the owner or a manager can confirm MMG payments.</span>}
          </p>
        )}
        <div className="mt-5 flex flex-col items-stretch gap-2 min-[400px]:flex-row min-[400px]:items-center min-[400px]:justify-center">
          {held ? (
            canConfirm ? (
              <button
                onClick={() => { setQueue((q) => q.filter((o) => o.id !== current.id)); onOpenOrder?.(current.id); }}
                className="min-h-11 w-full rounded-xl bg-green-600 px-8 py-3 text-lg font-extrabold text-white min-[400px]:w-auto"
              >
                Confirm MMG payment
              </button>
            ) : null
          ) : <>
          {!booking && <select
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
            ref={acceptRef}
            onClick={() => accept.mutate(current.id)}
            disabled={busy}
            className="min-h-11 w-full rounded-xl bg-green-600 px-8 py-3 text-lg font-extrabold text-white disabled:opacity-50 min-[400px]:w-auto"
          >
            Accept
          </button>
          </>}
          {!rejecting && (
            <button
              onClick={() => setRejecting(true)}
              disabled={busy}
              className="min-h-11 w-full rounded-xl border-2 border-[var(--swift-red)] px-6 py-3 text-lg font-bold text-[var(--swift-red)] disabled:opacity-50 min-[400px]:w-auto"
            >
              {booking ? 'Decline — tell us why' : 'Reject — tell us why'}
            </button>
          )}
        </div>
        {rejecting && (
          <div role="group" aria-label={booking ? 'Why are you declining?' : 'Why are you rejecting?'} className="mt-3 flex flex-col items-stretch gap-2">
            <p className="text-sm font-semibold">{booking ? 'Why are you declining? The customer is told.' : 'Why are you rejecting? The customer is told.'}</p>
            {rejectReasonsFor(current.fulfillment).map((why) => (
              <button
                key={why}
                onClick={() => reject.mutate({ id: current.id, reason: why })}
                disabled={busy}
                className="min-h-11 w-full rounded-xl border-2 border-[var(--swift-red)] px-4 py-2 font-bold text-[var(--swift-red)] disabled:opacity-50"
              >
                {why}
              </button>
            ))}
            <button
              onClick={() => setRejecting(false)}
              disabled={busy}
              className="min-h-11 w-full rounded-xl bg-black/5 px-4 py-2 font-semibold disabled:opacity-50"
            >
              Back
            </button>
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-[var(--swift-red)]">{error}</p>}
        <button
          onClick={() => done(current.id)}
          className="mt-4 min-h-11 text-sm text-[var(--swift-muted)] underline"
        >
          View later (the {booking ? 'booking' : 'order'} stays in your queue)
        </button>
      </div>
    </div>
  );
}
