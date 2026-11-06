'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatAmount } from '@/lib/money';
import { feeMoney } from '@/lib/fee-status';
import { FEE_ASK, feeLadderLine, feeQuote, feeSteps, feeTermsOf, fetchSignupPricing, privateCarsOpen, stepTrialLines, trialDaysOf, type FeeChoice, type FeeState, type SignupPricing } from '@/lib/signup-fee';
import styles from '../auth-flow.module.css';

/**
 * [COORD ruling 22 Oct 2026 · row 628] The weekly fee on the business and vehicle steps, above the
 * partner agreement: the server's amount for this business type or vehicle, the server's words
 * (what it covers, when it starts, how it is paid, the 14-day rule) and an unticked
 * "I understand the weekly fee". It reports to the page what the sign-up button may do (`onChange`);
 * the tick is given to exactly the amount and words on screen, so another vehicle or business type,
 * or a price read again, clears it. Loaded only on these steps (weekly-fee-loader.ts).
 */
export function WeeklyFee({ role, type, onChange, privateCar = false, onPrivateCars }: {
  role: FeeChoice['role'];
  /** The business type (a store) or the vehicle (a rider or driver). */
  type: string;
  onChange: (_state: FeeState) => void;
  /** [CARS-PLATES] A car on a private (P) plate: the delivery rider's fee. */
  privateCar?: boolean;
  /** [CARS-PLATES] Told whether the server says private cars deliver (the delivery door then offers a car). */
  onPrivateCars?: (_open: boolean) => void;
}) {
  const [pricing, setPricing] = useState<SignupPricing | 'loading' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [tickedFor, setTickedFor] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setPricing('loading');
    fetchSignupPricing().then((p) => { if (live) setPricing(p); }, () => { if (live) setPricing('error'); });
    return () => { live = false; };
  }, [attempt]);

  const view = useMemo(() => {
    if (typeof pricing !== 'object') return { state: { ask: pricing === 'loading' ? FEE_ASK.loading : FEE_ASK.error } as FeeState };
    const choice: FeeChoice = role === 'VENDOR' ? { role, vendorType: type } : { role, vehicleType: type, privateCar };
    const rate = feeQuote(pricing, choice);
    if (rate === null) return { state: { ask: FEE_ASK.missing } as FeeState };
    const terms = feeTermsOf(pricing);
    // [WEB-ONBOARDING · owner ruling 1 Nov 2026 (D1)] The free trial first, as the app's price card says it, from the
    // server's numbers; a list without a trial length shows the amount alone.
    const trial = trialDaysOf(pricing.trialDays);
    // [F30] Guyana dollars as every web fee screen writes them (GY$15,000 a week); another currency by its own symbol.
    const money = pricing.currencyCode === 'GYD' ? feeMoney(rate) : formatAmount(rate, pricing.currencySymbol);
    const amount = `${trial ? `${trial} days free, then ` : ''}${money} a week`;
    const steps = feeSteps(pricing, choice);
    if (terms === 'invalid') return { amount, steps, state: { ask: FEE_ASK.invalid } as FeeState };
    // An API older than the tick serves no words: the amount is shown, nothing is ticked or sent.
    if (terms === null) return { amount, steps, state: { ask: null } as FeeState };
    const key = `${terms.version}|${pricing.currencyCode}|${rate}`;
    const state: FeeState = tickedFor === key
      ? { ask: null, ack: { version: terms.version, amount: rate, currencyCode: pricing.currencyCode } }
      : { ask: FEE_ASK.tick, tick: true };
    return { amount, steps, terms, key, state };
  }, [pricing, role, type, privateCar, tickedFor]);
  useEffect(() => { onChange(view.state); }, [onChange, view.state]);
  useEffect(() => { if (typeof pricing === 'object') onPrivateCars?.(privateCarsOpen(pricing)); }, [pricing, onPrivateCars]);

  if (!view.amount) {
    return (
      <div className={styles.stackTight} role={pricing === 'error' ? 'alert' : 'status'}>
        <p className={styles.smallCopy}>{view.state.ask}</p>
        {pricing === 'error' ? <button type="button" className={styles.roleButton} onClick={() => setAttempt((n) => n + 1)}>Try again</button> : null}
      </div>
    );
  }
  const { terms, key } = view;
  return (
    <section aria-label="Your weekly fee" className={styles.stackTight}>
      <p className={styles.bodyCopy}><strong>Your weekly fee: {view.amount}</strong></p>
      {view.steps && typeof pricing === 'object' ? <p className={styles.smallCopy}>{feeLadderLine(pricing)}</p> : null}
      {typeof pricing === 'object' ? stepTrialLines(pricing, role === 'VENDOR' ? { role, vendorType: type } : { role, vehicleType: type }).map((line) => <p key={line} className={styles.smallCopy}>{line}</p>) : null}
      {terms ? terms.items.map((item) => (
        <p key={item.heading} className={styles.smallCopy}><strong>{item.heading}:</strong> {item.text}</p>
      )) : null}
      {terms && key ? (
        <label className={styles.legal} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={tickedFor === key} onChange={(e) => setTickedFor(e.target.checked ? key : null)} />
          <span>{terms.tick}</span>
        </label>
      ) : view.state.ask ? <p role="alert" className={styles.smallCopy}>{view.state.ask}</p> : null}
    </section>
  );
}
