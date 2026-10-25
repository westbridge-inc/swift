import { describe, expect, it } from 'vitest';
import { feeStatusFor, feeStatusWords, type FeeStatusFacts } from '../modules/billing/fee-status';

// [FEE-STATUS · owner 25 Oct 2026] A store's Weekly fee screen said "Nothing due
// right now: your next bill is 13 Oct 2026" with "Active" on 25 October: the
// paid week had ended on 13 Oct (Guyana time) and an abandoned MMG checkout's
// payment-confirmation hold had frozen the billing clock. A fee screen never
// presents a date that has passed as a next bill or as "active until". The
// server words every state once (feeStatus on GET /{family}/subscription).

const NOW = new Date('2026-10-25T16:52:00Z');
const base: FeeStatusFacts = {
  status: 'ACTIVE', nextBillingDate: new Date('2026-11-01T00:26:00Z'),
  isTrialActive: false, trialEndDate: null, isInGracePeriod: false, gracePeriodEnd: null,
  autoRenew: true, feeWaived: false, currencyCode: 'GYD',
  amountDue: 15_000, weeklyFee: 15_000, paidAhead: 0, checking: null, feePaused: false,
};
const words = (facts: Partial<FeeStatusFacts>) => feeStatusWords({ ...base, ...facts }, NOW);
// The owner's store on staging at 16:52Z: due 14 Oct 00:26Z (13 Oct in Guyana), ACTIVE, two weeks' money received.
const ownerStore = { nextBillingDate: new Date('2026-10-14T00:26:00Z'), amountDue: 0, paidAhead: 30_000 };

describe('fee status words [FEE-STATUS]', () => {
  it('the owner\'s store: never "next bill" or "active" on a date that has passed', () => {
    const s = words(ownerStore);
    expect(s.state).toBe('COVERED');
    expect(s.headline).toBe('Week from 13 Oct 2026 already paid');
    expect(`${s.headline} ${s.detail}`).not.toMatch(/next bill|active until|nothing due/i);
  });

  it('a future paid-through date reads "Paid until <date>" in Guyana time', () => {
    const s = words({});
    expect(s).toMatchObject({ state: 'PAID', headline: 'Paid until 31 Oct 2026', date: '2026-11-01T00:26:00.000Z' });
  });

  it('past the paid-through date and not paid: "Payment due since <date>" with the amount', () => {
    const s = words({ nextBillingDate: new Date('2026-10-14T00:26:00Z') });
    expect(s).toMatchObject({ state: 'DUE', headline: 'Payment due since 13 Oct 2026', detail: 'GY$15,000 to pay.' });
  });

  it('a grace window names its deadline only while it is still ahead', () => {
    expect(words({ status: 'PAST_DUE', isInGracePeriod: true, nextBillingDate: new Date('2026-10-24T12:00:00Z'), gracePeriodEnd: new Date('2026-10-26T12:00:00Z') }))
      .toMatchObject({ state: 'DUE', headline: 'Payment due since 24 Oct 2026', detail: 'GY$15,000 to pay. Pay by 26 Oct 2026 to keep receiving work.' });
    expect(words({ status: 'PAST_DUE', nextBillingDate: new Date('2026-10-20T12:00:00Z'), gracePeriodEnd: new Date('2026-10-22T12:00:00Z') }).detail)
      .toBe('GY$15,000 to pay.');
  });

  it('a payment held for a check: the amount and the day it began, never "pay"', () => {
    const s = words({ ...ownerStore, checking: { kind: 'PAYMENT', amount: 15_000, beganAt: new Date('2026-10-16T21:20:43Z') } });
    expect(s).toMatchObject({ state: 'CHECKING', headline: 'Checking your payment of GY$15,000 (began 16 Oct 2026)', detail: "Don't pay again while we check." });
    expect(words({ checking: { kind: 'PAYMENT', amount: 15_000, beganAt: new Date('2026-10-24T21:20:43Z') } }).detail)
      .toBe("Paid until 31 Oct 2026. Don't pay again while we check.");
    expect(words({ checking: { kind: 'PAYMENT', amount: null, beganAt: null } }).headline).toBe('Checking your payment');
    expect(words({ checking: { kind: 'REVIEW', amount: null, beganAt: null } }).headline).toBe('Swift is reviewing your weekly fee');
  });

  it('suspended and inactive say so, with what is owed since when', () => {
    expect(words({ status: 'SUSPENDED', nextBillingDate: new Date('2026-10-14T00:26:00Z') }))
      .toMatchObject({ state: 'SUSPENDED', headline: 'Account suspended', detail: 'GY$15,000 due since 13 Oct 2026. Pay it to start receiving work again.' });
    expect(words({ status: 'CHURNED', nextBillingDate: new Date('2026-09-14T00:26:00Z') }))
      .toMatchObject({ state: 'INACTIVE', headline: 'Account inactive' });
  });

  it('a free trial reads "Free trial until <date>"; an ended trial is due like any week', () => {
    expect(words({ isTrialActive: true, status: 'TRIAL', trialEndDate: new Date('2026-11-05T15:00:00Z'), nextBillingDate: new Date('2026-11-05T15:00:00Z') }))
      .toMatchObject({ state: 'TRIAL', headline: 'Free trial until 5 Nov 2026' });
    expect(words({ isTrialActive: true, trialEndDate: new Date('2026-10-20T15:00:00Z'), nextBillingDate: new Date('2026-10-20T15:00:00Z') }))
      .toMatchObject({ state: 'DUE', headline: 'Payment due since 20 Oct 2026' });
  });

  it('stopped billing, a server-wide fee pause, a waived week and a closed plan', () => {
    expect(words({ status: 'PAUSED', autoRenew: false }).state).toBe('STOPPED');
    expect(words({ autoRenew: false, nextBillingDate: new Date('2026-10-20T12:00:00Z') }).headline).toBe('Weekly billing stopped');
    expect(words({ autoRenew: false }).detail).toBe('Weekly billing is stopped: you receive no work after 31 Oct 2026.');
    expect(words({ feePaused: true, nextBillingDate: new Date('2026-10-20T12:00:00Z') }))
      .toMatchObject({ state: 'FEE_PAUSED', headline: 'Weekly fee paused' });
    expect(words({ feeWaived: true, amountDue: 0, nextBillingDate: new Date('2026-10-20T12:00:00Z') }).headline).toBe('No weekly fee for the week from 20 Oct 2026');
    expect(words({ status: 'CANCELLED' })).toMatchObject({ state: 'CLOSED', headline: 'Subscription closed' });
  });

  it('a next fee already paid is said in the owner #62 words (never wallet, balance or paid ahead)', () => {
    const s = words({ paidAhead: 15_000, amountDue: 0 });
    expect(s.detail).toBe('Your next weekly fee is already paid.');
    expect(`${s.headline} ${s.detail}`).not.toMatch(/wallet|balance|paid ahead|top.?up/i);
  });

  it('no state ever pairs a passed date with "until" or "next"', () => {
    const past = new Date('2026-10-14T00:26:00Z');
    const shapes: Array<Partial<FeeStatusFacts>> = [
      { nextBillingDate: past }, { nextBillingDate: past, amountDue: 0, paidAhead: 30_000 }, { nextBillingDate: past, status: 'PAST_DUE' },
      { nextBillingDate: past, status: 'SUSPENDED' }, { nextBillingDate: past, isTrialActive: true, trialEndDate: past },
      { nextBillingDate: past, autoRenew: false }, { nextBillingDate: past, feePaused: true }, { nextBillingDate: past, feeWaived: true },
      { nextBillingDate: past, checking: { kind: 'PAYMENT', amount: 15_000, beganAt: past } },
    ];
    for (const shape of shapes) {
      const s = words(shape);
      expect(`${s.headline} ${s.detail ?? ''}`, JSON.stringify(shape)).not.toMatch(/(?:until|next bill|next weekly fee is due on) 13 Oct 2026/i);
    }
  });
});

describe('fee status facts read from the database [FEE-STATUS]', () => {
  const sub = {
    id: 'sub-1', status: 'ACTIVE', nextBillingDate: new Date('2026-10-14T00:26:00Z'), isTrialActive: false, trialEndDate: null,
    isInGracePeriod: false, gracePeriodEnd: null, autoRenew: true, feeWaived: false, currencyCode: 'GYD',
  } as const;
  const fee = { amountDueGyd: 0, weeklyFeeGyd: 15_000, walletBalanceGyd: 30_000 };
  function db(opts: { hold?: unknown; review?: string | null; lateCard?: boolean; reversal?: boolean; paused?: boolean } = {}) {
    const calls: unknown[] = [];
    return {
      calls,
      paymentConfirmationHold: { findFirst: async (args: unknown) => { calls.push(args); return opts.hold ?? null; } },
      billingDunningClock: { findUnique: async () => (opts.review ? { authorityHoldReason: opts.review } : null) },
      moverFeeAuthority: { findUnique: async () => null },
      cardSession: { findFirst: async () => (opts.lateCard ? { id: 'c' } : null) },
      mmgFeeReversal: { findFirst: async () => (opts.reversal ? { id: 'r' } : null) },
      platformConfig: { findUnique: async () => null, findMany: async () => [] },
      feePaused: opts.paused ?? false,
    };
  }
  it('an active confirmation hold on the clock is "checking", with its checkout amount and start', async () => {
    const d = db({ hold: { beganAt: new Date('2026-10-16T21:20:43Z'), checkout: { amount: 15000 }, payment: null, cardSession: null } });
    const s = await feeStatusFor(d as never, sub as never, fee, NOW, { feePaused: async () => false });
    expect(s.headline).toBe('Checking your payment of GY$15,000 (began 16 Oct 2026)');
    expect(JSON.stringify(d.calls[0])).toContain('"ACTIVE","SETTLEMENT_APPLY_PENDING"');
  });
  it('no hold: the owner store reads as already paid from the money received', async () => {
    const s = await feeStatusFor(db() as never, sub as never, fee, NOW, { feePaused: async () => false });
    expect(s.state).toBe('COVERED');
  });
  it('a mover fee under finance review is "reviewing", never a pay prompt', async () => {
    const s = await feeStatusFor(db({ review: 'MOVER_FEE_REVIEW_REQUIRED' }) as never, { ...sub, amountDue: 15000 } as never, { ...fee, amountDueGyd: 15000, walletBalanceGyd: 0 }, NOW, { feePaused: async () => false });
    expect(s.headline).toBe('Swift is reviewing your weekly fee');
  });
  it('a server-wide fee pause reads as paused once the week is due', async () => {
    const s = await feeStatusFor(db() as never, sub as never, { ...fee, amountDueGyd: 15000, walletBalanceGyd: 0 }, NOW, { feePaused: async () => true });
    expect(s.state).toBe('FEE_PAUSED');
  });
});
