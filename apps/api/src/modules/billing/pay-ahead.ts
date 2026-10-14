import type { Prisma, Subscription } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { formatMoney } from '../../utils/currency-amount';
import { weeklyFeeAmount, type Priced } from './subscription-fee';

// ---------------------------------------------------------------------------
// [OWNER #62 · 14 Oct 2026, NO PAYING AHEAD] "shouldn't they just pay the
// weekly fee, no paying ahead": partners pay only the current week's fee. At
// most ONE week is held beyond the week that is running: while a week runs,
// the coming week may be paid; never a second one. (Was four weeks, owner
// ruling 8 Oct.) Swift holds no money for anyone: money received for the
// coming week is Swift's own fee paid early, spent only on that weekly fee,
// never withdrawn or sent on. Weeks paid ahead before this change (staging
// only) are honoured: they are spent week by week, and the unstarted ones are
// refunded at closing. A fixed rule in code, not a setting: raising it is a
// legal question (GUARDRAILS §8, F1), never a dial. One rule for every way
// money reaches a weekly fee:
//
//   - a door the partner opens (the MMG checkout, a card Pay now) refuses a
//     payment that would go past the cap, with plain words, BEFORE money moves;
//   - a payment an operator records by hand (an admin-recorded fee payment, an
//     agent payment attached by an admin) is refused the same way, naming the
//     most that can still be recorded — the rest is refunded to the partner;
//   - money that arrives without anyone opening a door (an agent payment, a
//     late MMG approval, a card capture for a week already paid) is never
//     refused or dropped once it is Swift's: an agent payment over the cap is
//     held for a person (refund), and a credit that lands over the cap pages
//     the operators to refund the part above it.
//
// What counts as "ahead": the fee paid ahead (prepaidBalance) plus whole weeks
// already paid beyond the week that is running (a card Pay now pays the next
// week by moving nextBillingDate). A free trial's weeks were not paid, so they
// never count. A week that is due now is not ahead: money that will pay it is
// allowed on top of the cap.
// ---------------------------------------------------------------------------

export const PAY_AHEAD_MAX_WEEKS = 1;
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
  /** The cap: PAY_AHEAD_MAX_WEEKS weekly fees. */
  cap: number;
  /** The most a new payment may add now. */
  room: number;
  /** How far the money held is over the cap (a refund is owed for it). */
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

/** Where this subscription stands against the cap. */
export function payAheadPosition(sub: PayAheadSub, paidAhead: number, now: Date): PayAheadPosition {
  const weeklyFee = weeklyFeeAmount(sub);
  const weeksAheadByDate = weeksPaidAheadByDate(sub, now);
  const due = sub.nextBillingDate.getTime() <= now.getTime() || DUE_STATUSES.has(sub.status);
  const heldAhead = cents(Math.max(0, paidAhead) + weeksAheadByDate * weeklyFee);
  const cap = cents(PAY_AHEAD_MAX_WEEKS * weeklyFee);
  const allowance = cap + (due ? weeklyFee : 0);
  return {
    weeklyFee, paidAhead, weeksAheadByDate, heldAhead, due, cap,
    room: cents(Math.max(0, allowance - heldAhead)),
    excess: cents(Math.max(0, heldAhead - allowance)),
    currencyCode: sub.currencyCode,
  };
}

type PayAheadDb = Pick<Prisma.TransactionClient, 'subscription' | 'prepaidBalance'>;

/** Read the position inside the caller's transaction (or on the pool). */
export async function readPayAhead(db: PayAheadDb, subscriptionId: string, now: Date): Promise<PayAheadPosition | null> {
  const [sub, balance] = await Promise.all([
    db.subscription.findUnique({
      where: { id: subscriptionId },
      select: { status: true, nextBillingDate: true, isTrialActive: true, trialEndDate: true, currencyCode: true, weeklyRate: true, customRate: true },
    }),
    db.prepaidBalance.findUnique({ where: { subscriptionId }, select: { balance: true } }),
  ]);
  return sub ? payAheadPosition(sub, Number(balance?.balance ?? 0), now) : null;
}

export const PAY_AHEAD_LIMIT = 'PAY_AHEAD_LIMIT';
/** Where an operator reads how the refund is made (PAY-AHEAD-AND-REFUNDS.md). */
const PROCEDURE = 'finance procedure: weekly fee refunds';

/** The refusal, in words for the person in front of it. */
export function payAheadRefusal(position: PayAheadPosition, audience: 'partner' | 'admin' | 'attach'): AppError {
  const details = { maxWeeks: PAY_AHEAD_MAX_WEEKS, roomGyd: position.room, currencyCode: position.currencyCode };
  if (audience === 'attach') {
    // An agent payment is attached whole or not at all: refunding it is the only action.
    return new AppError(409, PAY_AHEAD_LIMIT,
      `Attaching this agent payment would pay more than one week ahead on this account. It is attached whole or not at all: refund it to the partner instead (${PROCEDURE}).`, details);
  }
  if (audience === 'partner') {
    return new AppError(409, PAY_AHEAD_LIMIT,
      'Your next weekly fee is already paid. Swift takes the weekly fee one week at a time: you can pay again once that week has started.', details);
  }
  return new AppError(409, PAY_AHEAD_LIMIT, position.room > 0
    ? `This would pay more than one week ahead on this account. Record at most ${formatMoney(position.room, position.currencyCode)} now and refund the rest to the partner (${PROCEDURE}).`
    : `The next weekly fee on this account is already paid, and Swift takes one week at a time. Record nothing more: refund this payment to the partner (${PROCEDURE}).`, details);
}

/** Refuse a payment that would take the money held ahead past the cap. Call it
 *  inside the transaction that holds the payer lock, so two payments cannot
 *  both fit into the same room. */
export async function assertPayAheadRoom(db: PayAheadDb, subscriptionId: string, amount: number, now: Date, audience: 'partner' | 'admin'): Promise<PayAheadPosition | null> {
  const position = await readPayAhead(db, subscriptionId, now);
  if (position && cents(amount) > position.room) throw payAheadRefusal(position, audience);
  return position;
}
