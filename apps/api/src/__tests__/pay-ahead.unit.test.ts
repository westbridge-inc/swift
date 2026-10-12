import { describe, expect, it } from 'vitest';
import { PAY_AHEAD_MAX_WEEKS, payAheadPosition, payAheadRefusal, weeksPaidAheadByDate, type PayAheadSub } from '../modules/billing/pay-ahead';
import { manualFeeCreditHeld } from '../utils/fee-credit-hold';

// [OWNER RULING 8 Oct, NO "WALLET" (2)] Weekly fees can be paid at most four
// weeks ahead, counted the same way on every path: the fee paid ahead plus the
// whole weeks already paid beyond the running one (never a free trial's weeks);
// a week due now is not "ahead".

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

describe('the four-week cap', () => {
  it('is four weekly fees', () => {
    expect(PAY_AHEAD_MAX_WEEKS).toBe(4);
    expect(payAheadPosition(sub(), 0, NOW)).toMatchObject({ cap: 32_000, heldAhead: 0, room: 32_000, excess: 0, due: false });
  });

  it('counts the fee paid ahead and the weeks paid by date together', () => {
    const p = payAheadPosition(sub({ nextBillingDate: new Date(NOW.getTime() + 17 * DAY) }), 12_000, NOW);
    expect(p).toMatchObject({ weeksAheadByDate: 2, heldAhead: 28_000, room: 4_000, excess: 0 });
  });

  it('three weeks paid ahead leave room for one more week; four leave none', () => {
    expect(payAheadPosition(sub(), 3 * FEE, NOW).room).toBe(FEE);
    expect(payAheadPosition(sub(), 4 * FEE, NOW).room).toBe(0);
  });

  it('money for a week due now is allowed on top of the cap', () => {
    const overdue = sub({ status: 'PAST_DUE', nextBillingDate: new Date(NOW.getTime() - DAY) });
    expect(payAheadPosition(overdue, 4 * FEE, NOW)).toMatchObject({ due: true, room: FEE, excess: 0 });
  });

  it('names what is over the cap, so it can be refunded', () => {
    expect(payAheadPosition(sub(), 5 * FEE + 500, NOW)).toMatchObject({ room: 0, excess: FEE + 500 });
  });
});

describe('the refusal says what to do, in plain words', () => {
  it('to a partner: paid ahead as far as Swift allows, pay again once a week is used', () => {
    const e = payAheadRefusal(payAheadPosition(sub(), 4 * FEE, NOW), 'partner');
    expect(e).toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT', details: { maxWeeks: 4, roomGyd: 0 } });
    expect(e.message).toBe('Your weekly fee is already paid ahead as far as Swift allows (4 weeks). You can pay again once a week has been used.');
  });

  it('to an operator: the most that can still be recorded, and that the rest is refunded', () => {
    expect(payAheadRefusal(payAheadPosition(sub(), 3 * FEE, NOW), 'admin').message)
      .toBe('This would put more than 4 weeks of weekly fees paid ahead on this account. Record at most GY$8,000 now and refund the rest to the partner (finance procedure: weekly fees paid ahead).');
    expect(payAheadRefusal(payAheadPosition(sub(), 4 * FEE, NOW), 'admin').message)
      .toBe('This account already has 4 weeks of weekly fees paid ahead, the most Swift takes. Record nothing more: refund this payment to the partner (finance procedure: weekly fees paid ahead).');
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
