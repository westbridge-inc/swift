'use client';

import { useEffect, useState } from 'react';
import { money } from '@/lib/customer';
import { clockLabel, waitingView, type WaitingLive } from '@/lib/taxi-waiting';

/**
 * [WEB-TAXI · TAXI waiting charge §8.3 · research E4] The live wait on the
 * trip page, the phone's WaitingCard (apps/mobile TaxiStops.tsx): minutes
 * waited (ticking while a wait runs), the charge so far — always the server's
 * figure — and, while waiting, when the next charge lands. Drawn only when the
 * server sends the ride's `waiting` object (from the driver's arrival on).
 */
export function TaxiWaitingCard({ waiting }: { waiting: WaitingLive }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting.running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  const view = waitingView(waiting, now);
  const block = `${money(view.chargePerBlock)} per ${view.blockMinutes} minutes`;
  const chargeText = view.charge > 0 ? `${money(view.charge)} so far` : 'No charge yet';
  return (
    <section aria-labelledby="taxi-waiting-title" className="flex flex-col gap-1 rounded-2xl border border-[var(--swift-border)] bg-[var(--swift-card)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="taxi-waiting-title" className="sw-eyebrow">{view.running ? 'Waiting now' : 'Waiting'}</h2>
        <span className="sw-caption">{block}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3 font-semibold" aria-live="polite">
        <span>{view.minutes} min waited</span>
        <span>{chargeText}</span>
      </div>
      {view.nextChargeInSeconds != null ? (
        <p className="sw-caption">Next {money(view.chargePerBlock)} in {clockLabel(view.nextChargeInSeconds)}</p>
      ) : null}
      {waiting.pickupWaitMinutes != null ? <p className="sw-caption">At the pickup: {waiting.pickupWaitMinutes} min</p> : null}
      <p className="sw-caption">Paid in cash with your fare at the end.</p>
    </section>
  );
}
