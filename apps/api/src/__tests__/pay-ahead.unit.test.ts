import { describe, expect, it } from 'vitest';
import { PAY_AHEAD_MAX_WEEKS, payAheadPosition, payAheadRefusal, weeksPaidAheadByDate, type PayAheadSub } from '../modules/billing/pay-ahead';
import { manualFeeCreditHeld } from '../utils/fee-credit-hold';

// [OWNER #62 · 14 Oct, NO PAYING AHEAD] Partners pay only the current week's
// fee: at most ONE week is held beyond the running week (was four, 8 Oct),
// counted the same way on every path: money received for coming weeks plus the
// whole weeks already paid beyond the running one (never a free trial's
// weeks); a week due now is not "ahead".

const DAY = 86_400_000;
const NOW = new Date('2026-10-12T12:00:00Z');
const FEE = 8000;
const sub = (over: Partial<PayAheadSub> = {}): PayAheadSub => ({
  weeklyRate: FEE, customRate: null, status: 'ACTIVE', nextBillingDate: new Date(NOW.getTime() + 3 * DAY),
  isTrialActive: false, trialEndDate: null, currencyCode: 'GYD', ...over,
} as PayAheadSub);

describe('weeks already paid beyond the running week', () => {
  it('the running week is not ahead; each whole week paid after it is', () => {
    expect(weeksPaidAheadByDate(sub({ nextBillingDate: new Date(NOW.getTime() + 3 * DAY) }), NOW)).toBe(0);
    expect(weeksPaidAheadByDate(sub({ nextBillingDate: new Date(NOW.getTime() + 7 * DAY) }), NOW)).toBe(0);
    expect(weeksPaidAheadByDate(sub({ nextBillingDate: new Date(NOW.getTime() + 10 * DAY) }), NOW)).toBe(1);
    expect(weeksPaidAheadByDate(sub({ nextBillingDate: new Date(NOW.getTime() + 31 * DAY) }), NOW)).toBe(4);
  });

  it('an overdue week is not ahead', () => {
    expect(weeksPaidAheadByDate(sub({ nextBillingDate: new Date(NOW.getTime() - 2 * DAY) }), NOW)).toBe(0);
  });

  it('a free trial was not paid: only weeks paid after the trial count', () => {
    const trialEndDate = new Date(NOW.getTime() + 10 * DAY);
    expect(weeksPaidAheadByDate(sub({ status: 'TRIAL', isTrialActive: true, trialEndDate, nextBillingDate: trialEndDate }), NOW)).toBe(0);
    expect(weeksPaidAheadByDate(sub({ status: 'TRIAL', isTrialActive: true, trialEndDate, nextBillingDate: new Date(trialEndDate.getTime() + 14 * DAY) }), NOW)).toBe(2);
  });
});

describe('the one-week cap [owner #62]', () => {
  it('is one weekly fee', () => {
    expect(PAY_AHEAD_MAX_WEEKS).toBe(1);
    expect(payAheadPosition(sub(), 0, NOW)).toMatchObject({ cap: FEE, heldAhead: 0, room: FEE, excess: 0, due: false });
  });

  it('while a week runs, the next one may be paid, and nothing after it', () => {
    expect(payAheadPosition(sub(), 0, NOW).room, 'the coming week').toBe(FEE);
    expect(payAheadPosition(sub(), FEE, NOW).room, 'the coming week is already paid').toBe(0);
    expect(payAheadPosition(sub({ nextBillingDate: new Date(NOW.getTime() + 10 * DAY) }), 0, NOW).room, 'a card already paid the coming week').toBe(0);
    expect(payAheadPosition(sub(), FEE / 2, NOW).room, 'part of the coming week paid').toBe(FEE / 2);
  });

  it('counts the money received for coming weeks and the weeks paid by date together', () => {
    const p = payAheadPosition(sub({ nextBillingDate: new Date(NOW.getTime() + 10 * DAY) }), 3_000, NOW);
    expect(p).toMatchObject({ weeksAheadByDate: 1, heldAhead: FEE + 3_000, room: 0, excess: 3_000 });
  });

  it('a week due now is paid on top of the cap, and one week ahead stays the most', () => {
    const overdue = sub({ status: 'PAST_DUE', nextBillingDate: new Date(NOW.getTime() - DAY) });
    expect(payAheadPosition(overdue, 0, NOW)).toMatchObject({ due: true, room: 2 * FEE, excess: 0 });
    expect(payAheadPosition(overdue, FEE, NOW)).toMatchObject({ due: true, room: FEE, excess: 0 });
  });

  it('weeks paid ahead before the change (staging only) are kept, and what is over the cap is named for a refund', () => {
    expect(payAheadPosition(sub(), 4 * FEE, NOW)).toMatchObject({ heldAhead: 4 * FEE, room: 0, excess: 3 * FEE });
  });
});

describe('the refusal says what to do, in plain words', () => {
  it('to a partner: the next weekly fee is already paid; pay again once that week starts', () => {
    const e = payAheadRefusal(payAheadPosition(sub(), FEE, NOW), 'partner');
    expect(e).toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT', details: { maxWeeks: 1, roomGyd: 0 } });
    expect(e.message).toBe('Your next weekly fee is already paid. Swift takes the weekly fee one week at a time: you can pay again once that week has started.');
  });

  it('to a partner holding part of the coming week: how much is paid and the most that can be paid now, never "already paid"', () => {
    const e = payAheadRefusal(payAheadPosition(sub(), 600, NOW), 'partner');
    expect(e).toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT', details: { maxWeeks: 1, roomGyd: FEE - 600 } });
    expect(e.message).toBe('Swift takes the weekly fee one week at a time. GY$600 is already paid toward weeks that have not started, so you can pay at most GY$7,400 now.');
  });

  it('to an operator: the most that can still be recorded, and that the rest is refunded', () => {
    expect(payAheadRefusal(payAheadPosition(sub(), FEE / 2, NOW), 'admin').message)
      .toBe('This would pay more than one week ahead on this account. Record at most GY$4,000 now and refund the rest to the partner (finance procedure: weekly fee refunds).');
    expect(payAheadRefusal(payAheadPosition(sub(), FEE, NOW), 'admin').message)
      .toBe('The next weekly fee on this account is already paid, and Swift takes one week at a time. Record nothing more: refund this payment to the partner (finance procedure: weekly fee refunds).');
  });

  it('attaching an agent payment: whole or not at all, so it is refunded', () => {
    expect(payAheadRefusal(payAheadPosition(sub(), FEE, NOW), 'attach').message)
      .toBe('Attaching this agent payment would pay more than one week ahead on this account. It is attached whole or not at all: refund it to the partner instead (finance procedure: weekly fee refunds).');
  });
});

describe('[owner 8 Oct] crediting a fee by hand is held in production', () => {
  it('fails closed in production: unset is a hold; only an explicit 0 opens it', () => {
    expect(manualFeeCreditHeld({ NODE_ENV: 'production' })).toBe(true);
    expect(manualFeeCreditHeld({ NODE_ENV: 'production', BILLING_TOPUP_HOLD: '' })).toBe(true);
    expect(manualFeeCreditHeld({ NODE_ENV: 'production', BILLING_TOPUP_HOLD: '1' })).toBe(true);
    expect(manualFeeCreditHeld({ NODE_ENV: 'production', BILLING_TOPUP_HOLD: '0' })).toBe(false);
  });

  it('outside production unset stays open, 1 holds, and a wrongly written value holds', () => {
    expect(manualFeeCreditHeld({ NODE_ENV: 'development' })).toBe(false);
    expect(manualFeeCreditHeld({ NODE_ENV: 'development', BILLING_TOPUP_HOLD: '1' })).toBe(true);
    expect(manualFeeCreditHeld({ NODE_ENV: 'development', BILLING_TOPUP_HOLD: 'yes' })).toBe(true);
    expect(manualFeeCreditHeld({ NODE_ENV: 'development', BILLING_TOPUP_HOLD: '0' })).toBe(false);
  });
});
