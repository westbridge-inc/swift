import type { BillingDunningClock, PaymentConfirmationHold, Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';

export const FULL_FEE_GRACE_MS = 48 * 3_600_000;
export const FEE_RETRY_MS = 24 * 3_600_000;
export const ACTIVE_CONFIRMATION_STATES = ['ACTIVE', 'SETTLEMENT_APPLY_PENDING'];
type Tx = Prisma.TransactionClient;
export type ConfirmationSource = { paymentId: string } | { checkoutId: string } | { cardSessionId: string };
export type ConfirmationResolution = 'PAID' | 'PROVEN_UNPAID' | 'PROVEN_NO_EFFECT';

/** The same payer -> subscriptions -> clock/source order is used by collection,
 * confirmation and final notification handoff. No provider call belongs here. */
export async function lockBillingAuthority(tx: Tx, subscriptionId: string) {
  const select = {
    rider: { select: { userId: true } }, driver: { select: { userId: true } },
    vendor: { select: { owner: { select: { userId: true } } } },
  } as const;
  const candidate = await tx.subscription.findUnique({ where: { id: subscriptionId }, select });
  const userId = candidate?.rider?.userId ?? candidate?.driver?.userId ?? candidate?.vendor?.owner.userId;
  if (!userId) throw new AppError(409, 'BILLING_OWNER_UNAVAILABLE', 'The subscription needs review before billing can continue.');
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} ORDER BY "id" FOR UPDATE`;
  const sub = await tx.subscription.findUnique({ where: { id: subscriptionId }, include: select });
  const freshUser = sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { tenantId: true, status: true } });
  if (!sub || !user || freshUser !== userId) throw new AppError(409, 'BILLING_OWNER_CHANGED', 'The subscription owner changed. Try again.');
  return { sub, userId, tenantId: user.tenantId, userStatus: user.status };
}

export function activeOverdueMs(clock: Pick<BillingDunningClock, 'elapsedMs' | 'runningSince'>, now: Date): number {
  const value = Number(clock.elapsedMs) + (clock.runningSince ? Math.max(0, now.getTime() - clock.runningSince.getTime()) : 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid billing clock');
  return value;
}

export function activeDeadline(clock: BillingDunningClock, position: bigint | number, _now: Date): Date | null {
  if (clock.pausedAt) return null;
  if (!clock.runningSince) throw new Error('Running billing clock has no anchor');
  return new Date(clock.runningSince.getTime() + Number(position) - Number(clock.elapsedMs));
}

export async function projectDunningClock(tx: Tx, clock: BillingDunningClock, now: Date) {
  const deadline = activeDeadline(clock, FULL_FEE_GRACE_MS, now);
  await tx.subscription.update({ where: { id: clock.subscriptionId }, data: {
    billingConfirmationPausedAt: clock.pausedAt,
    billingEnforcementDueAt: deadline,
    gracePeriodEnd: deadline,
    nextRetryAt: clock.retryAtMs === null ? null : activeDeadline(clock, clock.retryAtMs, now),
  } });
}

async function clockRow(tx: Tx, subscriptionId: string, now: Date) {
  const { sub, tenantId } = await lockBillingAuthority(tx, subscriptionId);
  let clock = await tx.billingDunningClock.findUnique({ where: { subscriptionId } });
  if (!clock) {
    const age = Math.max(0, now.getTime() - sub.nextBillingDate.getTime());
    clock = await tx.billingDunningClock.create({ data: {
      subscriptionId, tenantId, dueAt: sub.nextBillingDate, runningSince: sub.nextBillingDate,
      retryAtMs: sub.nextRetryAt ? BigInt(age + Math.max(0, sub.nextRetryAt.getTime() - now.getTime())) : 0n,
      ...(sub.status === 'SUSPENDED' ? {
        nudgeAtMs: BigInt(age),
        churnAtMs: BigInt(age + Math.max(0, (sub.suspendedAt ?? sub.updatedAt).getTime() + suspensionRetentionMs() - now.getTime())),
      } : {}),
    } });
  }
  await tx.$queryRaw`SELECT "subscriptionId" FROM "billing_dunning_clocks" WHERE "subscriptionId" = ${subscriptionId} FOR UPDATE`;
  if (clock.tenantId !== tenantId) throw new AppError(409, 'BILLING_OWNER_CHANGED', 'The subscription needs review before billing can continue.');
  return clock;
}

export function suspensionRetentionMs() {
  const days = Number(process.env['SUSPENSION_MAX_DAYS'] ?? '30');
  return (Number.isFinite(days) && days > 0 ? days : 30) * FEE_RETRY_MS;
}

const sourceWhere = (source: ConfirmationSource) => source;

/** Caller owns payer/subscription locks. Sources are immutable, explicit FKs;
 * an existing resolved instruction cannot acquire a second hold by replay. */
export async function beginConfirmationInTx(
  tx: Tx, subscriptionId: string, source: ConfirmationSource, reason: string, now = new Date(),
): Promise<PaymentConfirmationHold> {
  let clock = await clockRow(tx, subscriptionId, now);
  const prior = await tx.paymentConfirmationHold.findFirst({ where: sourceWhere(source) });
  if (prior) {
    if (prior.subscriptionId !== subscriptionId) throw new AppError(409, 'PAYMENT_OWNER_MISMATCH', 'The payment needs review.');
    return prior;
  }
  const hold = await tx.paymentConfirmationHold.create({ data: {
    tenantId: clock.tenantId, subscriptionId, sourceEpoch: clock.epoch,
    ...source, reason, beganAt: now, reviewDueAt: new Date(now.getTime() + FEE_RETRY_MS),
  } });
  if (!clock.pausedAt) {
    clock = await tx.billingDunningClock.update({ where: { subscriptionId }, data: {
      elapsedMs: BigInt(activeOverdueMs(clock, now)), runningSince: null, pausedAt: now,
      version: { increment: 1 },
    } });
    await projectDunningClock(tx, clock, now);
  }
  return hold;
}

/** Covers pre-cutover rows and trusted source fixtures. Runtime adapters begin
 * at reservation/handoff; this repair never infers a negative from a timeout. */
async function discoverUnresolvedSources(tx: Tx, subscriptionId: string, now: Date) {
  const [checkouts, sessions, payments] = await Promise.all([
    tx.mmgCheckoutIntent.findMany({ where: { subscriptionId, status: { in: ['OPEN', 'CONFIRMING', 'HELD', 'EXPIRED'] } },
      select: { id: true, createdAt: true, reason: true } }),
    tx.cardSession.findMany({ where: { subscriptionId, purpose: 'PAY_NOW', OR: [
      { status: { in: ['OPEN', 'UNKNOWN', 'HELD'] } },
      { status: 'EXPIRED', failureCode: { not: 'PROVIDER_PAGE_UNAVAILABLE' } },
    ] }, select: { id: true, createdAt: true, paymentId: true, failureCode: true } }),
    tx.subscriptionPayment.findMany({ where: { subscriptionId, paymentMethod: { in: ['MOBILE_MONEY', 'CARD'] }, OR: [
      { status: { in: ['UNKNOWN', 'PENDING'] } },
      { failureCode: { in: ['REQUIRES_ACTION', 'AMOUNT_MISMATCH', 'SETTLEMENT_MISMATCH', 'HISTORY_APPROVAL_UNVERIFIED', 'CURRENCY_UNPINNED', 'WALLET_CURRENCY_MISMATCH', 'PROVIDER_NOT_FOUND'] } },
    ] }, select: { id: true, createdAt: true, failureCode: true, failureRaw: true, clientKey: true } }),
  ]);
  const sessionPayments = new Set(sessions.map((s) => s.paymentId).filter(Boolean));
  const sources: Array<{ source: ConfirmationSource; at: Date; reason: string }> = [
    ...checkouts.map((s) => ({ source: { checkoutId: s.id }, at: s.createdAt, reason: s.reason ?? 'MMG_CONFIRMATION_PENDING' })),
    ...sessions.map((s) => ({ source: { cardSessionId: s.id }, at: s.createdAt, reason: s.failureCode ?? 'CARD_CONFIRMATION_PENDING' })),
    ...payments.filter((p) => {
      const raw = p.failureRaw as Record<string, unknown> | null;
      return !sessionPayments.has(p.id) && !p.clientKey?.startsWith('cardpay:')
        && raw?.['providerEffect'] !== 'NOT_SENT';
    }).map((s) => ({ source: { paymentId: s.id }, at: s.createdAt, reason: s.failureCode ?? 'PAYMENT_CONFIRMATION_PENDING' })),
  ];
  sources.sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const source of sources) {
    await beginConfirmationInTx(tx, subscriptionId, source.source, source.reason,
      new Date(Math.min(source.at.getTime(), now.getTime())));
  }
}

export async function currentDunningClock(tx: Tx, subscriptionId: string, now = new Date(), discover = true) {
  await clockRow(tx, subscriptionId, now);
  if (discover) await discoverUnresolvedSources(tx, subscriptionId, now);
  const clock = await tx.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId } });
  await projectDunningClock(tx, clock, now);
  return clock;
}

export async function readDunningClock(db: PrismaClient, subscriptionId: string, now = new Date()) {
  return db.$transaction((tx) => currentDunningClock(tx, subscriptionId, now));
}

export async function hasConfirmationInTx(tx: Tx, subscriptionId: string, now: Date, except?: ConfirmationSource) {
  await currentDunningClock(tx, subscriptionId, now);
  return !!await tx.paymentConfirmationHold.findFirst({ where: {
    subscriptionId, status: { in: ACTIVE_CONFIRMATION_STATES }, ...(except ? { NOT: sourceWhere(except) } : {}),
  }, select: { id: true } });
}

/** A resolution never suspends. It only resumes the remaining schedule. The
 * next ordinary worker may enforce an already exhausted clock. */
export async function resolveConfirmationInTx(
  tx: Tx, subscriptionId: string, source: ConfirmationSource,
  resolution: ConfirmationResolution, evidence: { actor: string; reference: string }, now = new Date(),
) {
  await clockRow(tx, subscriptionId, now);
  if (!evidence.actor.trim() || !evidence.reference.trim()) throw new AppError(400, 'PAYMENT_RESOLUTION_EVIDENCE_REQUIRED', 'Record the confirmation evidence.');
  const hold = await tx.paymentConfirmationHold.findFirst({ where: sourceWhere(source) });
  if (!hold || hold.subscriptionId !== subscriptionId) throw new NotFoundError('Payment confirmation', subscriptionId);
  if (!ACTIVE_CONFIRMATION_STATES.includes(hold.status)) return hold;
  const resolved = await tx.paymentConfirmationHold.update({ where: { id: hold.id }, data: {
    status: resolution, resolvedAt: now, resolvedBy: evidence.actor, resolutionEvidence: evidence.reference,
  } });
  if (!await tx.paymentConfirmationHold.findFirst({ where: { subscriptionId, status: { in: ACTIVE_CONFIRMATION_STATES } }, select: { id: true } })) {
    const prior = await tx.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId } });
    const clock = await tx.billingDunningClock.update({ where: { subscriptionId }, data: {
      pausedAt: null, runningSince: new Date(Math.max(now.getTime(), prior.dueAt.getTime())),
      resumedAt: now, version: { increment: 1 },
    } });
    await projectDunningClock(tx, clock, now);
  }
  return resolved;
}

export async function markSettlementApplying(tx: Tx, subscriptionId: string, source: ConfirmationSource, now: Date) {
  const hold = await beginConfirmationInTx(tx, subscriptionId, source, 'SETTLEMENT_APPLY_PENDING', now);
  if (ACTIVE_CONFIRMATION_STATES.includes(hold.status)) {
    await tx.paymentConfirmationHold.update({ where: { id: hold.id }, data: { status: 'SETTLEMENT_APPLY_PENDING', reason: 'SETTLEMENT_APPLY_PENDING' } });
  }
}

export async function advanceDunningObligation(tx: Tx, subscriptionId: string, nextDue: Date, now: Date) {
  const previous = await clockRow(tx, subscriptionId, now);
  await tx.billingFeeNotice.updateMany({ where: { subscriptionId, epoch: previous.epoch, status: 'PENDING' }, data: { status: 'OBSOLETE' } });
  const held = await tx.paymentConfirmationHold.count({ where: { subscriptionId, status: { in: ACTIVE_CONFIRMATION_STATES } } });
  const clock = await tx.billingDunningClock.update({ where: { subscriptionId }, data: {
    dueAt: nextDue, epoch: { increment: 1 }, version: { increment: 1 }, elapsedMs: 0n,
    runningSince: held ? null : nextDue, pausedAt: held ? previous.pausedAt ?? now : null,
    retryAtMs: 0n, nudgeAtMs: null, churnAtMs: null,
  } });
  await projectDunningClock(tx, clock, now);
}

export async function scheduleDunningFailure(tx: Tx, subscriptionId: string, now: Date) {
  const current = await currentDunningClock(tx, subscriptionId, now);
  if (current.pausedAt) throw new AppError(409, 'PAYMENT_CONFIRMING', 'The weekly-fee payment is being confirmed.');
  const elapsed = activeOverdueMs(current, now);
  const clock = await tx.billingDunningClock.update({ where: { subscriptionId }, data: { retryAtMs: BigInt(elapsed + FEE_RETRY_MS) } });
  await projectDunningClock(tx, clock, now);
  return { clock, elapsed, maySuspend: elapsed >= FULL_FEE_GRACE_MS && current.resumedAt?.getTime() !== now.getTime() };
}
