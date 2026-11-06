import { describe, expect, it } from 'vitest';
import { PAY_AHEAD_MAX_WEEKS, PAY_AHEAD_MAX_WEEKS_WORD, payAheadPosition, payAheadRefusal, weeksPaidAheadByDate, type PayAheadSub } from '../modules/billing/pay-ahead';
import { manualFeeCreditHeld } from '../utils/fee-credit-hold';

// [OWNER · 6 Nov 2026, UP TO A MONTH AHEAD] Partners may pay the weekly fee up
// to FOUR weeks ahead (replaces owner #62's one week, 14 Oct), counted the same
// way on every path: money received for coming weeks plus the whole weeks
// already paid beyond the running one (never a free trial's weeks); a week due
// now is not "ahead". While a higher fee is told and not yet applied, a new
// payment reaches only weeks that start before its date (GUARDRAILS s7 rule 2).

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

describe('the four-week limit [owner 6 Nov]', () => {
  it('is four weekly fees, one constant, named in words from it', () => {
    expect(PAY_AHEAD_MAX_WEEKS).toBe(4);
    expect(PAY_AHEAD_MAX_WEEKS_WORD).toBe('four');
    expect(payAheadPosition(sub(), 0, NOW)).toMatchObject({ cap: 4 * FEE, heldAhead: 0, room: 4 * FEE, excess: 0, due: false, openWeeks: 4, riseFrom: null });
  });

  it('while a week runs, the four weeks after it may be paid, and never a fifth', () => {
    expect(payAheadPosition(sub(), 0, NOW).room, 'four coming weeks').toBe(4 * FEE);
    expect(payAheadPosition(sub(), 3 * FEE, NOW).room, 'three held: one more').toBe(FEE);
    expect(payAheadPosition(sub(), 4 * FEE, NOW).room, 'four held: nothing more').toBe(0);
    expect(payAheadPosition(sub({ nextBillingDate: new Date(NOW.getTime() + 10 * DAY) }), 0, NOW).room, 'a card already paid the coming week').toBe(3 * FEE);
    expect(payAheadPosition(sub(), FEE / 2, NOW).room, 'part of a week paid').toBe(3.5 * FEE);
  });

  it('counts the money received for coming weeks and the weeks paid by date together', () => {
    const byDate = sub({ nextBillingDate: new Date(NOW.getTime() + 10 * DAY) });
    expect(payAheadPosition(byDate, 3_000, NOW)).toMatchObject({ weeksAheadByDate: 1, heldAhead: FEE + 3_000, room: 3 * FEE - 3_000, excess: 0 });
    expect(payAheadPosition(byDate, 3 * FEE + 3_000, NOW)).toMatchObject({ heldAhead: 4 * FEE + 3_000, room: 0, excess: 3_000 });
  });

  it('a week due now is paid on top of the limit, and four weeks ahead stays the most', () => {
    const overdue = sub({ status: 'PAST_DUE', nextBillingDate: new Date(NOW.getTime() - DAY) });
    expect(payAheadPosition(overdue, 0, NOW)).toMatchObject({ due: true, room: 5 * FEE, excess: 0 });
    expect(payAheadPosition(overdue, FEE, NOW)).toMatchObject({ due: true, room: 4 * FEE, excess: 0 });
    expect(payAheadPosition(overdue, 6 * FEE, NOW)).toMatchObject({ due: true, room: 0, excess: FEE });
  });

  it('money held over the limit (it arrived anyway) is named for a refund', () => {
    expect(payAheadPosition(sub(), 6 * FEE, NOW)).toMatchObject({ heldAhead: 6 * FEE, room: 0, excess: 2 * FEE });
  });
});

describe('[GUARDRAILS s7 rule 2] a told rise: new money reaches only weeks before its date', () => {
  const next = new Date(NOW.getTime() + 3 * DAY);
  const WEEK = 7 * DAY;
  it('two weeks start before the told date: two may be paid, and the over-limit check still reads four', () => {
    const riseFrom = new Date(next.getTime() + 2 * WEEK);
    expect(payAheadPosition(sub(), 0, NOW, riseFrom)).toMatchObject({ openWeeks: 2, room: 2 * FEE, cap: 4 * FEE, riseFrom });
    // Three weeks held from before the notice: nothing more is taken, and none of it is "over the limit".
    expect(payAheadPosition(sub(), 3 * FEE, NOW, riseFrom)).toMatchObject({ room: 0, excess: 0 });
  });

  it('a week that starts on the told date is never paid at the old fee; a date far off leaves the four weeks', () => {
    expect(payAheadPosition(sub(), 0, NOW, next)).toMatchObject({ openWeeks: 0, room: 0 });
    expect(payAheadPosition(sub(), 0, NOW, new Date(next.getTime() + WEEK + 1))).toMatchObject({ openWeeks: 2, room: 2 * FEE });
    expect(payAheadPosition(sub(), 0, NOW, new Date(next.getTime() + 10 * WEEK))).toMatchObject({ openWeeks: 4, room: 4 * FEE });
  });

  it('a week due now is still paid; weeks paid by date count from the running week', () => {
    const overdue = sub({ status: 'PAST_DUE', nextBillingDate: new Date(NOW.getTime() - DAY) });
    expect(payAheadPosition(overdue, 0, NOW, new Date(NOW.getTime() - DAY + 2 * WEEK))).toMatchObject({ due: true, openWeeks: 1, room: 2 * FEE });
    const byDate = sub({ nextBillingDate: new Date(NOW.getTime() + 10 * DAY) });
    expect(payAheadPosition(byDate, 0, NOW, new Date(NOW.getTime() + 10 * DAY + WEEK))).toMatchObject({ openWeeks: 2, heldAhead: FEE, room: FEE });
  });
});

describe('the refusal says what to do, in plain words', () => {
  const next = new Date(NOW.getTime() + 3 * DAY);
  const riseFrom = new Date(next.getTime() + 2 * 7 * DAY);
  it('to a partner at the limit: paid as far as Swift takes it; pay again once the next week starts', () => {
    const e = payAheadRefusal(payAheadPosition(sub(), 4 * FEE, NOW), 'partner');
    expect(e).toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT', details: { maxWeeks: 4, roomGyd: 0 } });
    expect(e.message).toBe('Your weekly fee is already paid as far as Swift takes it, up to four weeks ahead. You can pay again once the next week has started.');
  });

  it('to a partner with room left: how much is paid and the most that can be paid now', () => {
    const e = payAheadRefusal(payAheadPosition(sub(), 600, NOW), 'partner');
    expect(e).toMatchObject({ statusCode: 409, code: 'PAY_AHEAD_LIMIT', details: { maxWeeks: 4, roomGyd: 4 * FEE - 600 } });
    expect(e.message).toBe('Swift takes the weekly fee up to four weeks ahead. GY$600 is already paid toward weeks that have not started, so you can pay at most GY$31,400 now.');
  });

  it('to a partner under a told rise: the date, and the most that can be paid before it', () => {
    const some = payAheadRefusal(payAheadPosition(sub(), FEE, NOW, riseFrom), 'partner');
    expect(some.details).toMatchObject({ maxWeeks: 4, roomGyd: FEE, riseFrom: riseFrom.toISOString() });
    expect(some.message).toBe('Your weekly fee goes up from the fee due on 29 October 2026. Until then Swift takes payment only for weeks that start before that day, so you can pay at most GY$8,000 now.');
    expect(payAheadRefusal(payAheadPosition(sub(), 2 * FEE, NOW, riseFrom), 'partner').message)
      .toBe('Your weekly fee goes up from the fee due on 29 October 2026, and every week before that day is already paid. You can pay again once the new fee applies.');
  });

  it('to an operator: the most that can still be recorded, and that the rest is refunded', () => {
    expect(payAheadRefusal(payAheadPosition(sub(), FEE / 2, NOW), 'admin').message)
      .toBe('This would pay more than four weeks ahead on this account. Record at most GY$28,000 now and refund the rest to the partner (finance procedure: weekly fee refunds).');
    expect(payAheadRefusal(payAheadPosition(sub(), 4 * FEE, NOW), 'admin').message)
      .toBe('This account is already paid as far as Swift takes it, up to four weeks ahead. Record nothing more: refund this payment to the partner (finance procedure: weekly fee refunds).');
    expect(payAheadRefusal(payAheadPosition(sub(), FEE, NOW, riseFrom), 'admin').message)
      .toBe("This account's weekly fee goes up from the fee due on 29 October 2026, and only weeks before that day can be paid now. Record at most GY$8,000 now and refund the rest to the partner (finance procedure: weekly fee refunds).");
    expect(payAheadRefusal(payAheadPosition(sub(), 2 * FEE, NOW, riseFrom), 'admin').message)
      .toBe("This account's weekly fee goes up from the fee due on 29 October 2026, and every week before that day is already paid. Record nothing more: refund this payment to the partner (finance procedure: weekly fee refunds).");
  });

  it('attaching an agent payment: whole or not at all, so it is refunded', () => {
    expect(payAheadRefusal(payAheadPosition(sub(), 4 * FEE, NOW), 'attach').message)
      .toBe('Attaching this agent payment would pay more than this account can take now (up to four weeks ahead). It is attached whole or not at all: refund it to the partner instead (finance procedure: weekly fee refunds).');
    expect(payAheadRefusal(payAheadPosition(sub(), 2 * FEE, NOW, riseFrom), 'attach').message)
      .toBe('Attaching this agent payment would pay more than this account can take now (up to four weeks ahead, and only weeks before its higher fee from 29 October 2026). It is attached whole or not at all: refund it to the partner instead (finance procedure: weekly fee refunds).');
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
