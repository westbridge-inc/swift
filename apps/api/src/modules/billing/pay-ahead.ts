import type { Prisma, Subscription } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { formatMoney } from '../../utils/currency-amount';
import { formatGuyanaTime } from '../../utils/guyana-day';
import { weeklyFeeAmount, type Priced } from './subscription-fee';
import { feeRiseKey, readHeldFeeRise } from './fee-rise-notice';

// ---------------------------------------------------------------------------
// [OWNER · 6 Nov 2026, UP TO A MONTH AHEAD] "one month at a time": a partner
// may pay the weekly fee up to FOUR weeks ahead. While a week runs, the four
// weeks after it may be paid; never a fifth. (Replaces owner #62 of 14 Oct, one
// week at a time; before that it was four weeks, owner ruling 8 Oct.) Swift
// holds no money for anyone: money received for weeks that have not started is
// Swift's own fee paid early, spent only on weekly fees, never withdrawn or
// sent on, and refunded at closing for every week that has not started. A
// fixed rule in code, not a setting: raising it is a legal question
// (GUARDRAILS s8, F1), never a dial. One rule for every way money reaches a
// weekly fee:
//
//   - a door the partner opens (the MMG checkout, a card Pay now) refuses a
//     payment that would go past the limit, with plain words, BEFORE money moves;
//   - a payment an operator records by hand (an admin-recorded fee payment, a
//     fee paid in person, an agent payment attached by an admin) is refused the same way, naming the
//     most that can still be recorded — the rest is refunded to the partner;
//   - money that arrives without anyone opening a door (an agent payment, a
//     late MMG approval, a card capture for a week already paid) is never
//     refused or dropped once it is Swift's: an agent payment over the limit is
//     held for a person (refund), and a credit that lands over the limit pages
//     the operators to refund the part above it.
//
// What counts as "ahead": the fee paid ahead (prepaidBalance) plus whole weeks
// already paid beyond the week that is running (a card Pay now pays the next
// week by moving nextBillingDate). A free trial's weeks were not paid, so they
// never count. A week that is due now is not ahead: money that will pay it is
// allowed on top of the limit.
//
// [GUARDRAILS s7 rule 2 · a paid week keeps its price] While a higher weekly
// fee has been told and not yet applied (fee-rise-notice.ts), a new payment may
// only pay ahead for weeks that start BEFORE the told date: a week paid at the
// old fee is never a week the rise then charges more for. Money held before the
// partner was told keeps its price the other way: the rise waits until every
// whole week held at the old fee is used (billing.service applyHeldFeeRiseInTx).
// ---------------------------------------------------------------------------

export const PAY_AHEAD_MAX_WEEKS = 4;
/** The limit in words, from the one constant (every partner, operator and legal line says it this way). */
export const PAY_AHEAD_MAX_WEEKS_WORD = (['zero', 'one', 'two', 'three', 'four', 'five', 'six'] as const)[PAY_AHEAD_MAX_WEEKS] ?? String(PAY_AHEAD_MAX_WEEKS);
const WEEK_MS = 7 * 86_400_000;
/** The same "due now" as the card Pay now quote (billing.service quoteCardPayNow). */
const DUE_STATUSES: ReadonlySet<string> = new Set(['PAST_DUE', 'SUSPENDED', 'CHURNED']);

export type PayAheadSub = Priced & Pick<Subscription, 'status' | 'nextBillingDate' | 'isTrialActive' | 'trialEndDate' | 'currencyCode'>;

export interface PayAheadPosition {
  weeklyFee: number;
  /** The fee paid ahead (prepaidBalance). */
  paidAhead: number;
  /** Whole weeks paid beyond the running week (or beyond a free trial). */
  weeksAheadByDate: number;
  /** Everything held for weeks that have not started. */
  heldAhead: number;
  /** A week is due now; money that pays it is not "ahead". */
  due: boolean;
  /** The limit: PAY_AHEAD_MAX_WEEKS weekly fees. */
  cap: number;
  /** How many weeks after the running (or due) week a new payment may reach: the limit, or fewer under a told rise. */
  openWeeks: number;
  /** The told date of a higher weekly fee not yet applied (fee-rise-notice.ts), or null. */
  riseFrom: Date | null;
  /** The most a new payment may add now. */
  room: number;
  /** How far the money held is over the limit (a refund is owed for it). Read against the limit alone: money
   *  held from before a rise was told is never "over". */
  excess: number;
  currencyCode: string;
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Whole weeks already paid beyond the week that is running. During a free
 *  trial, only weeks paid after the trial ends count. */
export function weeksPaidAheadByDate(sub: Pick<Subscription, 'status' | 'nextBillingDate' | 'isTrialActive' | 'trialEndDate'>, now: Date): number {
  const paidThrough = sub.nextBillingDate.getTime();
  const t = now.getTime();
  if (paidThrough <= t) return 0;
  const trialEnd = sub.trialEndDate?.getTime();
  if ((sub.isTrialActive || sub.status === 'TRIAL') && trialEnd !== undefined && trialEnd > t) {
    return Math.max(0, Math.floor((paidThrough - trialEnd) / WEEK_MS + 1e-9));
  }
  return Math.max(0, Math.ceil((paidThrough - t) / WEEK_MS - 1e-9) - 1);
}

/** Where this subscription stands against the limit. `riseFrom`: the told date of a higher fee not yet applied. */
export function payAheadPosition(sub: PayAheadSub, paidAhead: number, now: Date, riseFrom: Date | null = null): PayAheadPosition {
  const weeklyFee = weeklyFeeAmount(sub);
  const weeksAheadByDate = weeksPaidAheadByDate(sub, now);
  const due = sub.nextBillingDate.getTime() <= now.getTime() || DUE_STATUSES.has(sub.status);
  const heldAhead = cents(Math.max(0, paidAhead) + weeksAheadByDate * weeklyFee);
  const cap = cents(PAY_AHEAD_MAX_WEEKS * weeklyFee);
  // The week that is running (or due) ends here; the weeks ahead start from it, one a week.
  const runningEnd = due ? sub.nextBillingDate.getTime() + WEEK_MS : sub.nextBillingDate.getTime() - weeksAheadByDate * WEEK_MS;
  const beforeRise = riseFrom === null ? PAY_AHEAD_MAX_WEEKS : Math.max(0, Math.ceil((riseFrom.getTime() - runningEnd) / WEEK_MS));
  const openWeeks = Math.min(PAY_AHEAD_MAX_WEEKS, beforeRise);
  const dueFee = due ? weeklyFee : 0;
  return {
    weeklyFee, paidAhead, weeksAheadByDate, heldAhead, due, cap, openWeeks, riseFrom,
    room: cents(Math.max(0, openWeeks * weeklyFee + dueFee - heldAhead)),
    excess: cents(Math.max(0, heldAhead - (cap + dueFee))),
    currencyCode: sub.currencyCode,
  };
}

type PayAheadDb = Pick<Prisma.TransactionClient, 'subscription' | 'prepaidBalance' | 'platformConfig'>;

/** Read the position inside the caller's transaction (or on the pool). */
export async function readPayAhead(db: PayAheadDb, subscriptionId: string, now: Date): Promise<PayAheadPosition | null> {
  const [sub, balance, rise] = await Promise.all([
    db.subscription.findUnique({
      where: { id: subscriptionId },
      select: { status: true, nextBillingDate: true, isTrialActive: true, trialEndDate: true, currencyCode: true, weeklyRate: true, customRate: true },
    }),
    db.prepaidBalance.findUnique({ where: { subscriptionId }, select: { balance: true } }),
    db.platformConfig.findUnique({ where: { key: feeRiseKey(subscriptionId) }, select: { value: true } }),
  ]);
  // Only a TOLD rise limits a new payment: an untold one applies to nothing (fee-rise-notice.ts).
  const told = rise ? readHeldFeeRise(rise.value)?.appliesFrom ?? null : null;
  return sub ? payAheadPosition(sub, Number(balance?.balance ?? 0), now, told ? new Date(told) : null) : null;
}

export const PAY_AHEAD_LIMIT = 'PAY_AHEAD_LIMIT';
/** Where an operator reads how the refund is made (PAY-AHEAD-AND-REFUNDS.md). */
const PROCEDURE = 'finance procedure: weekly fee refunds';

/** True when a told rise, not the four-week limit, is what stops this payment. */
export function limitedByRise(position: PayAheadPosition): boolean {
  return position.riseFrom !== null && position.openWeeks < PAY_AHEAD_MAX_WEEKS;
}

/** The told date, as a partner reads it in the rise notice. */
export function riseDay(position: PayAheadPosition): string {
  return position.riseFrom ? formatGuyanaTime(position.riseFrom, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}

/** The limit in words: "up to four weeks ahead". */
export const PAY_AHEAD_LIMIT_WORDS = `up to ${PAY_AHEAD_MAX_WEEKS_WORD} weeks ahead`;

/** The refusal, in words for the person in front of it. */
export function payAheadRefusal(position: PayAheadPosition, audience: 'partner' | 'admin' | 'attach'): AppError {
  const rise = limitedByRise(position);
  const day = riseDay(position);
  const details = {
    maxWeeks: PAY_AHEAD_MAX_WEEKS, roomGyd: position.room, currencyCode: position.currencyCode,
    ...(rise ? { riseFrom: position.riseFrom!.toISOString() } : {}),
  };
  const room = formatMoney(position.room, position.currencyCode);
  if (audience === 'attach') {
    // An agent payment is attached whole or not at all: refunding it is the only action.
    return new AppError(409, PAY_AHEAD_LIMIT,
      `Attaching this agent payment would pay more than this account can take now (${PAY_AHEAD_LIMIT_WORDS}${rise ? `, and only weeks before its higher fee from ${day}` : ''}). It is attached whole or not at all: refund it to the partner instead (${PROCEDURE}).`, details);
  }
  if (audience === 'partner') {
    // [DS1114 S2] True in every case: part of a week held names what is paid and the most payable now.
    if (rise) {
      return new AppError(409, PAY_AHEAD_LIMIT, position.room > 0
        ? `Your weekly fee goes up from the fee due on ${day}. Until then Swift takes payment only for weeks that start before that day, so you can pay at most ${room} now.`
        : `Your weekly fee goes up from the fee due on ${day}, and every week before that day is already paid. You can pay again once the new fee applies.`, details);
    }
    return new AppError(409, PAY_AHEAD_LIMIT, position.room > 0
      ? `Swift takes the weekly fee ${PAY_AHEAD_LIMIT_WORDS}. ${formatMoney(position.heldAhead, position.currencyCode)} is already paid toward weeks that have not started, so you can pay at most ${room} now.`
      : `Your weekly fee is already paid as far as Swift takes it, ${PAY_AHEAD_LIMIT_WORDS}. You can pay again once the next week has started.`, details);
  }
  if (rise) {
    return new AppError(409, PAY_AHEAD_LIMIT, position.room > 0
      ? `This account's weekly fee goes up from the fee due on ${day}, and only weeks before that day can be paid now. Record at most ${room} now and refund the rest to the partner (${PROCEDURE}).`
      : `This account's weekly fee goes up from the fee due on ${day}, and every week before that day is already paid. Record nothing more: refund this payment to the partner (${PROCEDURE}).`, details);
  }
  return new AppError(409, PAY_AHEAD_LIMIT, position.room > 0
    ? `This would pay more than ${PAY_AHEAD_MAX_WEEKS_WORD} weeks ahead on this account. Record at most ${room} now and refund the rest to the partner (${PROCEDURE}).`
    : `This account is already paid as far as Swift takes it, ${PAY_AHEAD_LIMIT_WORDS}. Record nothing more: refund this payment to the partner (${PROCEDURE}).`, details);
}

/**
 * [DS1114 S3] Would a payment of `amount` fit now? A pay button is shown only
 * when it does: at the limit the door could only refuse, so there is no button.
 * A read, never a lock: the door checks again under it.
 */
export async function payAheadAllows(db: PayAheadDb, subscriptionId: string, amount: number, now: Date): Promise<boolean> {
  const position = await readPayAhead(db, subscriptionId, now);
  return !position || cents(amount) <= position.room;
}

/** Refuse a payment that would take the money held ahead past the limit. Call it
 *  inside the transaction that holds the payer lock, so two payments cannot
 *  both fit into the same room. */
export async function assertPayAheadRoom(db: PayAheadDb, subscriptionId: string, amount: number, now: Date, audience: 'partner' | 'admin'): Promise<PayAheadPosition | null> {
  const position = await readPayAhead(db, subscriptionId, now);
  if (position && cents(amount) > position.room) throw payAheadRefusal(position, audience);
  return position;
}
