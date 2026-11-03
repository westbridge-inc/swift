import type { Prisma } from '@prisma/client';
import { currentDunningClock, lockBillingAuthority, resumeVoluntaryObligationInTx } from './dunning-clock';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner ruling 2 Nov 2026] The weekly fee STOPS from the moment a store owner asks Swift to close the
// account. While the request is open, no new weekly fee is charged or falls due. If the owner cancels the request
// (or Swift's team ends it without closing the account), the fee resumes from then. Nothing already paid is refunded
// automatically.
//
// [REVIEW-M #2304 S2] The hold is its OWN narrow marker, subscriptions."closureHoldAt", and never auto-renew.
// Settlement applies a payment to a week already owed only on an auto-renewing plan, so a hold made of auto-renew
// banked such a payment as credit (and left the week owed). Here:
// - a week that starts at or after the hold is not born: the billing run does not charge it, does not remind about
//   it, and does not run its grace (billSubscription, sendUpcomingReminders);
// - at the end of the paid week the plan pauses, owing nothing, exactly as a partner's own stop lapses
//   (lapseStoppedSubscriptions, E12: proven coverage, the same database rules);
// - a week owed from before the hold (a request in flight, a checkout payment, a retry) settles exactly as ever.
// The hold ends inside the transaction that ends the request (the owner's cancel, staff's resolve): a plan the hold
// paused restarts due now through the partner's own resume (resumeVoluntaryObligationInTx), and any other plan just
// renews on its own date. So no week is billed twice and none is skipped.
// ---------------------------------------------------------------------------

export const CLOSURE_FEE_HOLD_NOTE = 'Weekly billing held: the owner asked Swift to close the account';
/** The lapse note when the hold, not the partner, paused the plan at the end of its paid week. */
export const CLOSURE_LAPSE_NOTE = 'Plan paused at the end of the paid period — the owner asked Swift to close the account';
export const BILLING_HELD_FOR_CLOSURE = 'BILLING_HELD_FOR_CLOSURE';
export const BILLING_RESUMED_AFTER_CLOSURE = 'BILLING_RESUMED_AFTER_CLOSURE';
export const BILLING_RESUME_AFTER_CLOSURE_FAILED = 'BILLING_RESUME_AFTER_CLOSURE_FAILED';
/** What the partner's own resume answers while the hold is on. */
export const CLOSURE_FEE_HOLD_REFUSAL = 'Your weekly fee is on hold while your account closure request is open. It restarts if you cancel the request.';

/** Does the closure hold keep the week that starts at `weekStart` from being born? */
export function closureHoldsWeek(sub: { closureHoldAt: Date | null }, weekStart: Date): boolean {
  return !!sub.closureHoldAt && weekStart.getTime() >= sub.closureHoldAt.getTime();
}

/** Hold the weekly fee of every store the person owns, inside the closure request's transaction (the person row is
 *  already locked there; the payer lock is that same row, then each subscription in id order: the billing order).
 *  Only an auto-renewing plan is held (a fee the partner stopped themselves stays theirs). Idempotent. */
export async function holdStoreFeesForClosureInTx(tx: Prisma.TransactionClient, userId: string, ticketId: string, now = new Date()): Promise<string[]> {
  const tenant = await tx.user.findUnique({ where: { id: userId }, select: { tenant: { select: { kind: true } } } });
  // The store-review fiction has no weekly billing to hold (as stopBilling refuses it).
  if (!tenant || tenant.tenant.kind === 'REVIEW') return [];
  const subs = await tx.subscription.findMany({
    where: { vendor: { owner: { userId } }, autoRenew: true, closureHoldAt: null, status: { notIn: ['CANCELLED', 'CHURNED'] } },
    select: { id: true }, orderBy: { id: 'asc' },
  });
  const held: string[] = [];
  for (const { id } of subs) {
    const { sub: fresh, userId: payer } = await lockBillingAuthority(tx, id);
    if (payer !== userId || !fresh.autoRenew || fresh.closureHoldAt || fresh.status === 'CANCELLED' || fresh.status === 'CHURNED') continue;
    await tx.subscription.update({ where: { id }, data: { closureHoldAt: now, closureHoldTicketId: ticketId } });
    await tx.billingEvent.create({ data: {
      subscriptionId: id, type: 'TIER_CHANGE', currencyCode: fresh.currencyCode,
      idempotencyKey: `closure-hold:${id}:${ticketId}:${now.toISOString()}`, note: CLOSURE_FEE_HOLD_NOTE,
    } });
    await tx.auditLog.create({ data: {
      userId, action: BILLING_HELD_FOR_CLOSURE, entity: 'Subscription', entityId: id,
      changes: { ticketId, closureHoldAt: now.toISOString() },
    } });
    held.push(id);
  }
  return held;
}

export type ClosureFeeOutcome = 'RENEWS_ON_ITS_DATE' | 'RESTARTED_NOW' | 'PAYMENT_CONFIRMING' | 'REVIEW_REQUIRED' | 'PARTNER_STOPPED';

/** End the hold of every fee this closure request held, inside the transaction that ends the request (the person
 *  row is locked there). Each ending is audited. Returns what happened to each fee. */
export async function endClosureFeeHoldsInTx(
  tx: Prisma.TransactionClient, ticketId: string, actorId: string | null, now = new Date(),
): Promise<Array<{ subscriptionId: string; outcome: ClosureFeeOutcome }>> {
  const subs = await tx.subscription.findMany({ where: { closureHoldTicketId: ticketId }, select: { id: true }, orderBy: { id: 'asc' } });
  const out: Array<{ subscriptionId: string; outcome: ClosureFeeOutcome }> = [];
  for (const { id } of subs) {
    const { sub: fresh } = await lockBillingAuthority(tx, id);
    if (fresh.closureHoldTicketId !== ticketId) continue;
    const clock = await currentDunningClock(tx, id, now);
    let outcome: ClosureFeeOutcome = 'RENEWS_ON_ITS_DATE';
    if (fresh.status === 'PAUSED' && !fresh.autoRenew) {
      // Paused by the hold (its lapse note) or by the partner's own stop.
      const lapse = await tx.billingEvent.findFirst({
        where: { subscriptionId: id, type: 'TIER_CHANGE', idempotencyKey: `pause:${id}:${clock.id}:${clock.epoch}` }, select: { note: true },
      });
      if (lapse?.note !== CLOSURE_LAPSE_NOTE) outcome = 'PARTNER_STOPPED';
      else if (clock.pausedAt) outcome = 'PAYMENT_CONFIRMING';
      else outcome = await resumeVoluntaryObligationInTx(tx, fresh, clock, now) ? 'RESTARTED_NOW' : 'REVIEW_REQUIRED';
    }
    await tx.subscription.update({ where: { id }, data: { closureHoldAt: null, closureHoldTicketId: null } });
    const fine = outcome === 'RENEWS_ON_ITS_DATE' || outcome === 'RESTARTED_NOW' || outcome === 'PARTNER_STOPPED';
    await tx.auditLog.create({ data: {
      userId: actorId, action: fine ? BILLING_RESUMED_AFTER_CLOSURE : BILLING_RESUME_AFTER_CLOSURE_FAILED, entity: 'Subscription', entityId: id,
      changes: { ticketId, outcome },
    } });
    out.push({ subscriptionId: id, outcome });
  }
  return out;
}

/** The owner's sentence about the fee once the request ends. */
export function feeEndingWords(outcomes: ReadonlyArray<{ outcome: ClosureFeeOutcome }>): string {
  if (outcomes.some((o) => o.outcome === 'PAYMENT_CONFIRMING' || o.outcome === 'REVIEW_REQUIRED')) {
    return ' Your weekly fee stays stopped for now: start it again on the Weekly fee page.';
  }
  return outcomes.some((o) => o.outcome === 'RENEWS_ON_ITS_DATE' || o.outcome === 'RESTARTED_NOW') ? ' Your weekly fee starts again from today.' : '';
}
