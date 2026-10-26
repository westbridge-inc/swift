import type { PrismaClient, Subscription } from '@prisma/client';
import { formatMoney } from '../../utils/currency-amount';
import { ACTIVE_CONFIRMATION_STATES, feeReversalOpenInTx, lateCardApprovalHeldInTx } from './dunning-clock';
import { feePauseHoldsBilling } from './mmg-pause';

// ---------------------------------------------------------------------------
// [FEE-STATUS · owner 25 Oct 2026] THE words for where a partner's weekly fee
// stands, worked out once on the server and sent with every
// GET /{vendor|rider|driver}/subscription as `feeStatus`.
//
// The owner's store read "Nothing due right now: your next bill is 13 Oct
// 2026" and "Active" on 25 October. The week had ended on 13 Oct (Guyana
// time); an abandoned MMG checkout's payment-confirmation hold had frozen the
// billing clock, so nothing moved the row on. Each app worked the line out for
// itself from the raw row and printed a date that had passed as the next bill.
// The rule here: a date that has passed is never "until" or "next". A week
// past its date is due (or already paid from money received), a hold is
// "checking", a suspension says so, and a trial names its end.
//
// Dates are Guyana days ("13 Oct 2026", the apps' own feeDate format); money
// is formatMoney. Nothing here is a promise about a way to pay: the Pay button
// stays payActions' (fee-pay-actions.ts) and only the server decides it.
// ---------------------------------------------------------------------------

export type FeeStatusState =
  | 'TRIAL' | 'PAID' | 'UPCOMING' | 'COVERED' | 'DUE' | 'CHECKING' | 'FEE_PAUSED' | 'SUSPENDED' | 'INACTIVE' | 'STOPPED' | 'CLOSED';

export interface FeeStatus {
  state: FeeStatusState;
  /** The line the fee screen leads with. */
  headline: string;
  /** One more plain line, or null. */
  detail: string | null;
  /** The instant the headline's date names, or null. */
  date: string | null;
}

/** Why a fee is being checked: a payment of the partner's, or the fee itself under review. */
export type FeeCheck = { kind: 'PAYMENT' | 'REVIEW'; amount: number | null; beganAt: Date | null };

export interface FeeStatusFacts {
  status: string;
  nextBillingDate: Date;
  isTrialActive: boolean;
  trialEndDate: Date | null;
  isInGracePeriod: boolean;
  gracePeriodEnd: Date | null;
  autoRenew: boolean;
  feeWaived: boolean;
  currencyCode: string;
  /** payInfo's amountDueGyd: THE amount due now (amount-due.ts). */
  amountDue: number;
  /** payInfo's weeklyFeeGyd: the rate in force. */
  weeklyFee: number;
  /** Money received for a week that has not been applied yet (payInfo's walletBalanceGyd). */
  paidAhead: number;
  /** A captured payment of more than 0 bought the week that runs to nextBillingDate. A date alone
   *  never proves payment (a trial, a waived week, a reactivation after a fee pause all set one). */
  paidThroughProven: boolean;
  /** A payment (or the fee) held for a person's check, or null. */
  checking: FeeCheck | null;
  /** No partner can pay right now, so no weekly fee is charged (mmg-pause.ts). */
  feePaused: boolean;
}

const GUYANA_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Guyana' });
const day = (at: Date) => GUYANA_DAY.format(at);

/** The words, from the facts alone (pure: the unit tests pin every state). */
export function feeStatusWords(f: FeeStatusFacts, now: Date): FeeStatus {
  const money = (n: number) => formatMoney(n, f.currencyCode);
  const due = f.nextBillingDate.getTime() <= now.getTime();
  const dueDate = f.nextBillingDate.toISOString();
  const status = String(f.status).toUpperCase();
  if (status === 'CANCELLED') return { state: 'CLOSED', headline: 'Subscription closed', detail: null, date: null };

  // A payment held for a check comes first: the one thing the partner must not
  // do is pay again, whatever else is true of the row.
  if (f.checking) {
    const c = f.checking;
    const headline = c.kind === 'REVIEW'
      ? 'Swift is reviewing your weekly fee'
      : `Checking your payment${c.amount != null && c.amount > 0 ? ` of ${money(c.amount)}` : ''}${c.beganAt ? ` (began ${day(c.beganAt)})` : ''}`;
    const paidUntil = !due && f.paidThroughProven && (status === 'ACTIVE' || status === 'PAST_DUE') && !f.isTrialActive ? `Paid until ${day(f.nextBillingDate)}. ` : '';
    return { state: 'CHECKING', headline, detail: `${paidUntil}Don't pay again while we check.`, date: c.beganAt?.toISOString() ?? null };
  }

  const owed = f.amountDue > 0 ? f.amountDue : f.weeklyFee;
  if (status === 'SUSPENDED' || status === 'CHURNED') {
    const what = owed > 0 ? money(owed) : 'The weekly fee';
    return {
      state: status === 'SUSPENDED' ? 'SUSPENDED' : 'INACTIVE',
      headline: status === 'SUSPENDED' ? 'Account suspended' : 'Account inactive',
      detail: `${what} due ${due ? `since ${day(f.nextBillingDate)}` : 'now'}. Pay it to start receiving work again.`,
      date: due ? dueDate : null,
    };
  }
  if (status === 'PAUSED' || (!f.autoRenew && due)) {
    return { state: 'STOPPED', headline: 'Weekly billing stopped', detail: 'You receive no work while it is stopped. Resume weekly billing to start again.', date: null };
  }

  const trialing = f.isTrialActive || status === 'TRIAL';
  const trialEnd = f.trialEndDate && f.trialEndDate.getTime() > now.getTime() ? f.trialEndDate : !due ? f.nextBillingDate : null;
  if (trialing && trialEnd) return { state: 'TRIAL', headline: `Free trial until ${day(trialEnd)}`, detail: null, date: trialEnd.toISOString() };

  const behind = status === 'PAST_DUE' || f.isInGracePeriod;
  if (!due && !behind) {
    const detail = !f.autoRenew
      ? `Weekly billing is stopped: you receive no work after ${day(f.nextBillingDate)}.`
      : f.feeWaived
        ? 'Your next weekly fee is waived.'
        : f.weeklyFee > 0 && f.paidAhead >= f.weeklyFee
          // [OWNER RULING 8 Oct, NO "WALLET" · owner #62] never a wallet, a balance or "paid ahead".
          ? 'Your next weekly fee is already paid.'
          : null;
    // "Paid until" only on a captured payment's word; otherwise the date is the next fee's, nothing more.
    return f.paidThroughProven
      ? { state: 'PAID', headline: `Paid until ${day(f.nextBillingDate)}`, detail, date: dueDate }
      : { state: 'UPCOMING', headline: `Next weekly fee due on ${day(f.nextBillingDate)}`, detail, date: dueDate };
  }

  // The week is due (or a charge for it failed). With no live way to pay, no
  // fee is charged at all (owner 5 Oct: weeks Swift could not take payment for
  // are not back-billed).
  if (f.feePaused) return { state: 'FEE_PAUSED', headline: 'Weekly fee paused', detail: 'Swift is not charging the weekly fee right now.', date: null };
  if (!behind) {
    if (f.feeWaived) return { state: 'COVERED', headline: `No weekly fee for the week from ${day(f.nextBillingDate)}`, detail: 'Swift waived it.', date: dueDate };
    if (!(f.weeklyFee > 0)) return { state: 'COVERED', headline: 'No weekly fee to pay', detail: null, date: null };
    // Money already received pays the week: the billing run applies it.
    if (!(f.amountDue > 0)) {
      return { state: 'COVERED', headline: `Week from ${day(f.nextBillingDate)} already paid`, detail: 'Swift applies the payment you already made. Nothing more is due for this week.', date: dueDate };
    }
  }
  const grace = f.gracePeriodEnd && f.gracePeriodEnd.getTime() > now.getTime() ? ` Pay by ${day(f.gracePeriodEnd)} to keep receiving work.` : '';
  const amount = f.amountDue > 0 ? `${money(f.amountDue)} to pay.` : '';
  return {
    state: 'DUE',
    headline: due ? `Payment due since ${day(f.nextBillingDate)}` : 'Payment due now',
    detail: `${amount}${grace}`.trim() || null,
    date: due ? dueDate : null,
  };
}

type StatusDb = Pick<PrismaClient, 'paymentConfirmationHold' | 'billingDunningClock' | 'moverFeeAuthority' | 'cardSession' | 'mmgFeeReversal' | 'platformConfig' | 'subscriptionPayment'>;
type StatusSub = Pick<Subscription, 'id' | 'status' | 'nextBillingDate' | 'isTrialActive' | 'trialEndDate' | 'isInGracePeriod' | 'gracePeriodEnd' | 'autoRenew' | 'feeWaived' | 'currencyCode'>;

/**
 * The check a partner's fee is under, read only (a GET must not lock or move
 * the billing clock). The same sources that hold billing (dunning-clock.ts
 * hasConfirmationInTx): an active confirmation hold on this fee's clock (with
 * the checkout's, payment's or card session's amount), a mover fee under
 * finance review, a late card approval held for a person, or a weekly-fee
 * payment being returned through MMG.
 */
async function feeCheck(db: StatusDb, sub: StatusSub): Promise<FeeCheck | null> {
  const hold = await db.paymentConfirmationHold.findFirst({
    where: { status: { in: ACTIVE_CONFIRMATION_STATES }, OR: [{ subscriptionId: sub.id }, { clock: { subscriptionId: sub.id } }] },
    orderBy: { beganAt: 'desc' },
    select: { beganAt: true, checkout: { select: { amount: true } }, payment: { select: { amount: true } }, cardSession: { select: { amount: true } } },
  });
  if (hold) {
    const raw = hold.checkout?.amount ?? hold.payment?.amount ?? hold.cardSession?.amount ?? null;
    return { kind: 'PAYMENT', amount: raw == null ? null : Number(raw), beganAt: hold.beganAt };
  }
  const clock = await db.billingDunningClock.findUnique({ where: { subscriptionId: sub.id }, select: { authorityHoldReason: true } });
  if (clock?.authorityHoldReason) return { kind: 'REVIEW', amount: null, beganAt: null };
  const authority = await db.moverFeeAuthority.findUnique({ where: { canonicalSubscriptionId: sub.id }, select: { members: { select: { subscriptionId: true } } } });
  const sourceIds = authority?.members.map((m) => m.subscriptionId) ?? [sub.id];
  if (await lateCardApprovalHeldInTx(db as PrismaClient, sourceIds) || await feeReversalOpenInTx(db as PrismaClient, sourceIds)) {
    return { kind: 'PAYMENT', amount: null, beganAt: null };
  }
  return null;
}

/** feeStatus for a subscription payload: `fee` is the payInfo block the payload already carries. */
export async function feeStatusFor(
  db: StatusDb,
  sub: StatusSub,
  fee: { amountDueGyd: number; weeklyFeeGyd: number; walletBalanceGyd: number },
  now = new Date(),
  deps: { feePaused?: (_db: StatusDb, _subscriptionId: string) => Promise<boolean> } = {},
): Promise<FeeStatus> {
  const [checking, feePaused, paid] = await Promise.all([
    feeCheck(db, sub),
    (deps.feePaused ?? ((d, id) => feePauseHoldsBilling(d as PrismaClient, id)))(db, sub.id),
    // The week that runs to nextBillingDate was bought by a captured payment (billing.service books
    // every paid week as one CAPTURED row whose periodEnd becomes nextBillingDate; a waived week is 0).
    db.subscriptionPayment.findFirst({
      where: { subscriptionId: sub.id, status: 'CAPTURED', amount: { gt: 0 }, periodEnd: { gte: sub.nextBillingDate } },
      select: { id: true },
    }),
  ]);
  return feeStatusWords({
    status: sub.status, nextBillingDate: sub.nextBillingDate, isTrialActive: sub.isTrialActive, trialEndDate: sub.trialEndDate,
    isInGracePeriod: sub.isInGracePeriod, gracePeriodEnd: sub.gracePeriodEnd, autoRenew: sub.autoRenew, feeWaived: sub.feeWaived,
    currencyCode: sub.currencyCode, amountDue: fee.amountDueGyd, weeklyFee: fee.weeklyFeeGyd, paidAhead: fee.walletBalanceGyd,
    paidThroughProven: !!paid, checking, feePaused,
  }, now);
}
