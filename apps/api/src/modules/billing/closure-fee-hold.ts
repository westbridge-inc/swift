import type { Prisma, PrismaClient } from '@prisma/client';
import { currentDunningClock, lockBillingAuthority } from './dunning-clock';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// [WEB-DELETE · owner ruling 2 Nov 2026] The weekly fee STOPS from the moment a store owner asks Swift to close the
// account: no new weekly fee is charged or falls due while the request is open. If the owner cancels the request
// (or Swift's team ends it without closing the account), the fee resumes from then. Nothing already paid is
// refunded automatically.
//
// The hold is a partner's own "stop weekly billing" (BillingService.stopBilling, E12), done by the closure request in
// its own transaction and keyed to that request:
// - autoRenew false and no retry: no new week is charged or retried;
// - a week already paid runs to its end, then lapses to PAUSED owing nothing (lapseStoppedSubscriptions);
// - a week already owed stays owed.
// Resuming is the partner's own resume (BillingService.setBillingRail on the plan's own rail), which is the tested
// path that restarts a PAUSED plan due now, or lets a still-paid week renew on its own date. So nothing is billed
// twice and no week is skipped. Only a fee this request held is resumed: a fee the partner had stopped themselves
// stays stopped.
// ---------------------------------------------------------------------------

export const CLOSURE_FEE_HOLD_NOTE = 'Weekly billing held: the owner asked Swift to close the account';
export const BILLING_HELD_FOR_CLOSURE = 'BILLING_HELD_FOR_CLOSURE';
export const BILLING_RESUMED_AFTER_CLOSURE = 'BILLING_RESUMED_AFTER_CLOSURE';
const holdKeyPrefix = (subscriptionId: string, ticketId: string) => `closure-hold:${subscriptionId}:${ticketId}:`;

/** Hold the weekly fee of every store the person owns, inside the closure request's transaction (the person row is
 *  already locked there: the payer lock is the same row, then each subscription, in id order, the billing order).
 *  Idempotent: a fee already stopped is left alone. Returns the subscriptions held. */
export async function holdStoreFeesForClosureInTx(tx: Prisma.TransactionClient, userId: string, ticketId: string): Promise<string[]> {
  const tenant = await tx.user.findUnique({ where: { id: userId }, select: { tenant: { select: { kind: true } } } });
  // The store-review fiction has no weekly billing to hold (as stopBilling refuses it).
  if (!tenant || tenant.tenant.kind === 'REVIEW') return [];
  const subs = await tx.subscription.findMany({
    where: { vendor: { owner: { userId } }, autoRenew: true, status: { notIn: ['CANCELLED', 'CHURNED'] } },
    select: { id: true }, orderBy: { id: 'asc' },
  });
  const held: string[] = [];
  for (const { id } of subs) {
    const { sub: fresh, userId: payer } = await lockBillingAuthority(tx, id);
    if (payer !== userId) continue;
    await currentDunningClock(tx, id);
    if (!fresh.autoRenew || fresh.status === 'CANCELLED' || fresh.status === 'CHURNED') continue;
    await tx.subscription.update({ where: { id }, data: { autoRenew: false, nextRetryAt: null } });
    await tx.billingEvent.create({ data: {
      subscriptionId: id, type: 'TIER_CHANGE', currencyCode: fresh.currencyCode,
      idempotencyKey: `${holdKeyPrefix(id, ticketId)}${fresh.updatedAt.toISOString()}`, note: CLOSURE_FEE_HOLD_NOTE,
    } });
    await tx.auditLog.create({ data: {
      userId, action: BILLING_HELD_FOR_CLOSURE, entity: 'Subscription', entityId: id,
      changes: { ticketId, autoRenew: false, nextRetryAt: null },
    } });
    held.push(id);
  }
  return held;
}

type Resumer = { setBillingRail(subscriptionId: string, method: 'CASH' | 'MOBILE_MONEY', mmgPayerMsisdn?: string): Promise<unknown> };

/** After the request ended without closing the account (the owner cancelled it, or Swift's team resolved it): resume
 *  each fee this request held and that is still stopped, on its own rail, through the partner's resume. Runs after
 *  the ending commits (the resume takes the same payer lock). Returns the subscriptions resumed. */
export async function resumeStoreFeesAfterClosure(
  prisma: PrismaClient, billing: Resumer, ticketId: string, actorId: string | null,
): Promise<string[]> {
  const held = await prisma.billingEvent.findMany({
    where: { type: 'TIER_CHANGE', note: CLOSURE_FEE_HOLD_NOTE, idempotencyKey: { contains: `:${ticketId}:` } },
    select: { subscriptionId: true, idempotencyKey: true },
  });
  const resumed: string[] = [];
  for (const id of [...new Set(held.filter((e) => e.idempotencyKey?.startsWith(holdKeyPrefix(e.subscriptionId, ticketId))).map((e) => e.subscriptionId))]) {
    const sub = await prisma.subscription.findUnique({ where: { id }, select: { autoRenew: true, status: true, billingMethod: true, mmgPayerMsisdn: true } });
    // Resumed by the partner meanwhile, or closed: nothing to do.
    if (!sub || sub.autoRenew || sub.status === 'CANCELLED' || sub.status === 'CHURNED') continue;
    const method = sub.billingMethod === 'MOBILE_MONEY' ? 'MOBILE_MONEY' as const : sub.billingMethod === 'CASH' ? 'CASH' as const : null;
    try {
      if (!method || (method === 'MOBILE_MONEY' && !sub.mmgPayerMsisdn)) throw new Error(`no resumable rail (${sub.billingMethod})`);
      await billing.setBillingRail(id, method, sub.mmgPayerMsisdn ?? undefined);
      await prisma.auditLog.create({ data: { userId: actorId, action: BILLING_RESUMED_AFTER_CLOSURE, entity: 'Subscription', entityId: id, changes: { ticketId } } });
      resumed.push(id);
    } catch (err) {
      // Never a silent drop: the fee stays stopped (nothing is charged) and the partner resumes it on the weekly-fee page.
      log().error({ err, subscriptionId: id, ticketId }, '[WEB-DELETE] weekly fee not resumed after the closure request ended');
      await prisma.auditLog.create({ data: { userId: actorId, action: 'BILLING_RESUME_AFTER_CLOSURE_FAILED', entity: 'Subscription', entityId: id, changes: { ticketId } } }).catch(() => undefined);
    }
  }
  return resumed;
}
