import { billingEffectsReady } from './billing-cutover';
import { hasMmgTerminalProof, mmgPaymentRaw } from './mmg-terminal-evidence';
import { lockSubscriptionPayer, lockMoverFeeAuthority, type MoverFeeResolution } from '../subscription/mover-fee-authority';
import type { BillingDunningClock, PaymentConfirmationHold, Prisma, PrismaClient, Subscription, SubscriptionPayment } from '@prisma/client';
import { settledFeePeriodInTx, voluntaryResumeProofInTx, voluntaryLapseInTx } from './obligation-evidence';
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
  const payer = await lockSubscriptionPayer(tx, subscriptionId);
  const userId = payer.userId;
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: {
    rider: { select: { userId: true } }, driver: { select: { userId: true } },
    vendor: { select: { owner: { select: { userId: true } } } },
  } });
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true, status: true } });
  return { sub, userId, tenantId: user.tenantId, userStatus: user.status };
}

export function activeOverdueMs(clock: Pick<BillingDunningClock, 'elapsedMs' | 'runningSince'>, now: Date): number {
  const value = Number(clock.elapsedMs) + (clock.runningSince ? Math.max(0, now.getTime() - clock.runningSince.getTime()) : 0);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid billing clock');
  return value;
}

/** A resume is never stamped before its own pause. Callers pass their own
 * clock; an earlier (skewed) caller time resumes at the pause instant and so
 * counts no overdue time for the gap. The database refuses anything else. */
export function resumeInstant(clock: Pick<BillingDunningClock, 'pausedAt'>, now: Date): Date {
  return clock.pausedAt && clock.pausedAt.getTime() > now.getTime() ? clock.pausedAt : now;
}

/** A resolution never suspends in its own instant, and a caller whose time is
 * not after the last resume (clock skew) never suspends either. */
export function resumedNoEarlierThan(clock: Pick<BillingDunningClock, 'resumedAt'>, now: Date): boolean {
  return !!clock.resumedAt && clock.resumedAt.getTime() >= now.getTime();
}

export function activeDeadline(clock: BillingDunningClock, position: bigint | number, _now: Date): Date | null {
  if (clock.pausedAt) return null;
  if (!clock.runningSince) throw new Error('Running billing clock has no anchor');
  return new Date(clock.runningSince.getTime() + Number(position) - Number(clock.elapsedMs));
}

export async function projectDunningClock(tx: Tx, clock: BillingDunningClock, now: Date) {
  const ready = await billingEffectsReady(tx);
  const deadline = ready ? activeDeadline(clock, FULL_FEE_GRACE_MS, now) : null;
  const authority = await tx.moverFeeAuthority.findUnique({ where: { canonicalSubscriptionId: clock.subscriptionId }, include: { members: true } });
  const ids = authority?.members.map((m) => m.subscriptionId) ?? [clock.subscriptionId];
  const sources = await tx.subscription.findMany({ where: { id: { in: ids } } });
  for (const sub of sources) {
    const data = {
      billingConfirmationPausedAt: ready ? clock.pausedAt : sub.billingConfirmationPausedAt ?? now,
      billingEnforcementDueAt: deadline,
      gracePeriodEnd: sub.status === 'PAST_DUE' ? deadline : sub.gracePeriodEnd,
      // An ordinary ACTIVE paid period needs no retry marker. Original aliases
      // retain independently imposed manual restrictions but never collect.
      // A closed, cancelled or paused row is never retried: its marker stays clear.
      nextRetryAt: !ready || sub.id !== clock.subscriptionId || !sub.autoRenew || clock.retryAtMs === null
        || (['TRIAL', 'ACTIVE'].includes(sub.status) && !sub.failedAttempts)
        || !['ACTIVE', 'PAST_DUE', 'SUSPENDED'].includes(sub.status)
        ? null : activeDeadline(clock, clock.retryAtMs, now),
    };
    const same = (a: Date | null, b: Date | null) => a?.getTime() === b?.getTime();
    if (same(sub.billingConfirmationPausedAt, data.billingConfirmationPausedAt)
      && same(sub.billingEnforcementDueAt, data.billingEnforcementDueAt)
      && same(sub.gracePeriodEnd, data.gracePeriodEnd) && same(sub.nextRetryAt, data.nextRetryAt)) continue;
    await tx.subscription.update({ where: { id: sub.id }, data });
  }
}

type SettledProof = NonNullable<Awaited<ReturnType<typeof settledFeePeriodInTx>>>;
async function recordObligationTransition(tx: Tx, previous: BillingDunningClock, sub: Subscription,
  proof: SettledProof, kind: 'PAID' | 'VOLUNTARY_RESUME', nextDue: Date, now: Date, lapseEventId: string | null = null) {
  // The settled money keeps the currency its success record was booked in.
  const currencyCode = proof.event.currencyCode;
  const audit = await tx.auditLog.create({ data: {
    action: kind === 'PAID' ? 'BILLING_CLOCK_PAID_ADVANCE' : 'BILLING_CLOCK_VOLUNTARY_RESUME',
    entity: 'BillingDunningClock', entityId: previous.id,
    changes: { clockId: previous.id, tenantId: previous.tenantId, fromSubscriptionId: previous.subscriptionId,
      subscriptionId: sub.id, previousEpoch: previous.epoch, nextEpoch: previous.epoch + 1,
      previousDue: previous.dueAt.toISOString(), nextDue: nextDue.toISOString(),
      paymentId: proof.payment.id, successEventId: proof.event.id, lapseEventId,
      currencyCode, amount: proof.payment.amount.toString() },
  } });
  return tx.billingObligationTransition.create({ data: {
    tenantId: previous.tenantId, clockId: previous.id, fromSubscriptionId: previous.subscriptionId,
    subscriptionId: sub.id, kind, fromEpoch: previous.epoch, toEpoch: previous.epoch + 1,
    fromDue: previous.dueAt, toDue: nextDue, effectiveAt: now, paymentId: proof.payment.id,
    successEventId: proof.event.id, lapseEventId, auditId: audit.id, amount: proof.payment.amount,
    currencyCode, periodStart: proof.payment.periodStart, periodEnd: proof.payment.periodEnd,
  } });
}

/** Change only the canonical projection of the same stable clock. The mover
 * resolver has already written its exact independently approved decision. */
async function moveCanonicalClockInTx(tx: Tx, clock: BillingDunningClock, authority: MoverFeeResolution, now: Date) {
  const persisted = await tx.moverFeeAuthority.findUniqueOrThrow({ where: { userId: authority.payerUserId }, include: { decision: true } });
  const facts = persisted.decision.changes as Prisma.JsonObject | null;
  const refuse = () => new AppError(409, 'BILLING_CLOCK_TRANSITION_REQUIRED', 'The current weekly-fee obligation needs reconciliation before choosing another source.');
  if (clock.moverPayerUserId !== authority.payerUserId || clock.tenantId !== authority.tenantId
    || persisted.decision.action !== 'MOVER_FEE_RESOLVED' || facts?.['previousRevision'] !== clock.authorityRevision
    || authority.revision !== (clock.authorityRevision ?? 0) + 1
    || await tx.paymentConfirmationHold.count({ where: { clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES } } })) throw refuse();
  const original = await tx.subscription.findUniqueOrThrow({ where: { id: clock.subscriptionId } });
  const next = await tx.subscription.findUniqueOrThrow({ where: { id: authority.canonicalSubscriptionId } });
  const sameDue = next.nextBillingDate.getTime() === clock.dueAt.getTime();
  if (next.currencyCode !== original.currencyCode) throw refuse();
  if (sameDue && (next.currentPeriodStart.getTime() !== original.currentPeriodStart.getTime()
    || next.currentPeriodEnd.getTime() !== original.currentPeriodEnd.getTime())) throw refuse();
  let paymentProof: string | null = null;
  let covered: SettledProof | null = null;
  if (!sameDue) {
    if (next.currentPeriodStart > clock.dueAt || next.currentPeriodEnd <= clock.dueAt
      || next.currentPeriodEnd.getTime() !== next.nextBillingDate.getTime()) throw refuse();
    const payment = await tx.subscriptionPayment.findFirst({ where: { subscriptionId: next.id, status: 'CAPTURED', paidAt: { not: null },
      periodStart: next.currentPeriodStart, periodEnd: next.currentPeriodEnd, externalRef: { not: null } } });
    const event = payment && await tx.billingEvent.findFirst({ where: { subscriptionId: next.id, type: 'CHARGE_SUCCESS',
      amount: payment.amount, currencyCode: next.currencyCode, paymentRef: payment.externalRef } });
    if (!payment || !event) throw refuse();
    paymentProof = payment.id;
    covered = { payment, event };
  }
  const snapshot = JSON.parse(JSON.stringify(clock, (_key, value) => typeof value === 'bigint' ? value.toString() : value)) as Prisma.InputJsonObject;
  await tx.auditLog.create({ data: { action: 'BILLING_CLOCK_CANONICAL_CHANGED', entity: 'BillingDunningClock', entityId: clock.id,
    changes: { clockId: clock.id, tenantId: clock.tenantId, payerUserId: authority.payerUserId, previous: snapshot,
      canonicalSubscriptionId: next.id, authorityRevision: authority.revision, authorityDecisionId: persisted.decisionId, paymentProof } } });
  if (covered) await recordObligationTransition(tx, clock, next, covered, 'PAID', next.nextBillingDate, now);
  if (!sameDue) await tx.billingFeeNotice.updateMany({ where: { clockId: clock.id, epoch: clock.epoch, status: 'PENDING' }, data: { status: 'OBSOLETE' } });
  return tx.billingDunningClock.update({ where: { id: clock.id }, data: {
    subscriptionId: next.id,
    ...(!sameDue ? { dueAt: next.nextBillingDate, epoch: { increment: 1 }, elapsedMs: 0n, runningSince: null, pausedAt: now,
      retryAtMs: 0n, nudgeAtMs: null, churnAtMs: null, resumedAt: null } : {}),
  } });
}

/** Called with the payer and all original subscription rows already locked. */
async function canonicalClockRow(tx: Tx, subscriptionId: string, tenantId: string, now: Date, moverPayerUserId: string | null = null) {
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  let clock = await tx.billingDunningClock.findUnique({ where: { subscriptionId } });
  if (!clock) {
    const age = Math.max(0, now.getTime() - sub.nextBillingDate.getTime());
    clock = await tx.billingDunningClock.create({ data: {
      subscriptionId, tenantId, moverPayerUserId, dueAt: sub.nextBillingDate, runningSince: sub.nextBillingDate,
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

/** The authority resolver calls this after persisting its audited decision.
 * It does not call the resolver again or invent a separate pause clock. */
export async function syncMoverDunningAuthorityInTx(tx: Tx, authority: MoverFeeResolution, now = new Date()) {
  const subscriptionId = authority.canonicalSubscriptionId;
  let clock = await tx.billingDunningClock.findUnique({ where: { moverPayerUserId: authority.payerUserId } });
  if (clock && clock.subscriptionId !== subscriptionId) clock = await moveCanonicalClockInTx(tx, clock, authority, now);
  clock ??= await canonicalClockRow(tx, subscriptionId, authority.tenantId, now, authority.payerUserId);
  const reason = authority.state === 'FINANCE_HOLD' ? authority.holdReason ?? 'MOVER_FEE_REVIEW_REQUIRED' : null;
  if (clock.authorityHoldReason !== reason || clock.authorityRevision !== authority.revision) {
    const paymentsHeld = await tx.paymentConfirmationHold.count({ where: { clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES } } });
    const pause = reason !== null || paymentsHeld > 0;
    clock = await tx.billingDunningClock.update({ where: { subscriptionId }, data: {
      authorityHoldReason: reason, authorityRevision: authority.revision, version: { increment: 1 },
      ...(pause && !clock.pausedAt ? { elapsedMs: BigInt(activeOverdueMs(clock, now)), runningSince: null, pausedAt: now } : {}),
      ...(!pause && clock.pausedAt ? { runningSince: new Date(Math.max(resumeInstant(clock, now).getTime(), clock.dueAt.getTime())),
        pausedAt: null, resumedAt: resumeInstant(clock, now) } : {}),
    } });
  }
  await projectDunningClock(tx, clock, now);
  return clock;
}

async function clockRow(tx: Tx, subscriptionId: string, now: Date) {
  const payer = await lockSubscriptionPayer(tx, subscriptionId);
  if (payer.kind === 'MOVER') {
    const authority = await lockMoverFeeAuthority(tx, payer);
    if (!authority) throw new AppError(409, 'BILLING_OWNER_UNAVAILABLE', 'The subscription needs review before billing can continue.');
    return syncMoverDunningAuthorityInTx(tx, authority, now);
  }
  return canonicalClockRow(tx, subscriptionId, payer.tenantId, now);
}

/** How long a plan may stay SUSPENDED before it is CHURNED: the operator's
 * BILLING_SUSPENSION_MAX_DAYS (the setting the billing service always read),
 * else 30 days. */
export function suspensionRetentionMs() {
  const days = Number(process.env['BILLING_SUSPENSION_MAX_DAYS'] ?? '30');
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
    if (prior.clockId !== clock.id) throw new AppError(409, 'PAYMENT_OWNER_MISMATCH', 'The payment needs review.');
    return prior;
  }
  const hold = await tx.paymentConfirmationHold.create({ data: {
    tenantId: clock.tenantId, subscriptionId, clockId: clock.id, sourceEpoch: clock.epoch,
    ...source, reason, beganAt: now, reviewDueAt: new Date(now.getTime() + FEE_RETRY_MS),
  } });
  if (!clock.pausedAt) {
    clock = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
      elapsedMs: BigInt(activeOverdueMs(clock, now)), runningSince: null, pausedAt: now,
      version: { increment: 1 },
    } });
    await projectDunningClock(tx, clock, now);
  }
  return hold;
}

/** Shared source census for both locked effects and read-only pay actions.
 * Local expiry is never negative payment evidence. */
export async function confirmationSources(tx: Tx | PrismaClient, sourceIds: string[]) {
  const sourceSubscription = { in: sourceIds };
  const [checkouts, sessions, payments, legacyTerminal] = await Promise.all([
    tx.mmgCheckoutIntent.findMany({ where: { subscriptionId: sourceSubscription, status: { in: ['OPEN', 'CONFIRMING', 'HELD', 'EXPIRED'] } },
      select: { id: true, subscriptionId: true, createdAt: true, reason: true } }),
    tx.cardSession.findMany({ where: { subscriptionId: sourceSubscription, purpose: 'PAY_NOW', OR: [
      { status: { in: ['OPEN', 'UNKNOWN', 'HELD'] } },
      { status: 'EXPIRED', OR: [{ failureCode: null }, { failureCode: { not: 'PROVIDER_PAGE_UNAVAILABLE' } }] },
    ] }, select: { id: true, subscriptionId: true, createdAt: true, paymentId: true, failureCode: true } }),
    tx.subscriptionPayment.findMany({ where: { subscriptionId: sourceSubscription, paymentMethod: { in: ['MOBILE_MONEY', 'CARD'] }, OR: [
      { status: { in: ['UNKNOWN', 'PENDING'] } },
      { failureCode: { in: ['REQUIRES_ACTION', 'AMOUNT_MISMATCH', 'SETTLEMENT_MISMATCH', 'HISTORY_APPROVAL_UNVERIFIED', 'CURRENCY_UNPINNED', 'WALLET_CURRENCY_MISMATCH', 'PROVIDER_NOT_FOUND'] } },
    ] }, select: { id: true, subscriptionId: true, createdAt: true, failureCode: true, failureRaw: true, clientKey: true } }),
    tx.subscriptionPayment.findMany({ where: { subscriptionId: sourceSubscription, paymentMethod: 'MOBILE_MONEY', status: { in: ['FAILED', 'EXPIRED'] } } }),
  ]);
  const terminals: Array<{ payment: SubscriptionPayment; proof: Prisma.JsonObject }> = [];
  for (const payment of legacyTerminal) {
    const raw = mmgPaymentRaw(payment);
    if (raw['providerEffect'] === 'NOT_SENT' && !payment.externalRef) continue;
    const attempt = payment.clientKey?.startsWith(`sub:${payment.subscriptionId}:`)
      ? await tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${payment.clientKey.slice(4)}` } }) : null;
    if (hasMmgTerminalProof(payment, attempt?.currencyCode ?? null)) {
      terminals.push({ payment, proof: raw['mmgTerminalEvidence'] as Prisma.JsonObject });
    } else payments.push(payment);
  }
  const sessionPayments = new Set(sessions.map((s) => s.paymentId).filter(Boolean));
  const sources: Array<{ subscriptionId: string; source: ConfirmationSource; at: Date; reason: string }> = [
    ...checkouts.map((s) => ({ subscriptionId: s.subscriptionId, source: { checkoutId: s.id }, at: s.createdAt, reason: s.reason ?? 'MMG_CONFIRMATION_PENDING' })),
    ...sessions.map((s) => ({ subscriptionId: s.subscriptionId, source: { cardSessionId: s.id }, at: s.createdAt, reason: s.failureCode ?? 'CARD_CONFIRMATION_PENDING' })),
    ...payments.filter((p) => {
      const raw = p.failureRaw as Record<string, unknown> | null;
      return !sessionPayments.has(p.id) && !p.clientKey?.startsWith('cardpay:')
        && raw?.['providerEffect'] !== 'NOT_SENT';
    }).map((s) => ({ subscriptionId: s.subscriptionId, source: { paymentId: s.id }, at: s.createdAt, reason: s.failureCode ?? 'PAYMENT_CONFIRMATION_PENDING' })),
  ];
  return { sources: sources.sort((a, b) => a.at.getTime() - b.at.getTime()), terminals };
}

/** Covers pre-cutover rows and trusted source fixtures. Runtime adapters begin
 * at reservation/handoff; this repair never infers a negative from a timeout. */
async function discoverUnresolvedSources(tx: Tx, subscriptionId: string, now: Date) {
  const authority = await tx.moverFeeAuthority.findUnique({ where: { canonicalSubscriptionId: subscriptionId }, include: { members: true } });
  const sourceIds = authority?.members.map((m) => m.subscriptionId) ?? [subscriptionId];
  const { sources, terminals } = await confirmationSources(tx, sourceIds);
  for (const { payment, proof } of terminals) {
    // Retain proven historical closure without pausing today's clock.
    if (await tx.paymentConfirmationHold.findUnique({ where: { paymentId: payment.id } })) continue;
    const clock = await tx.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId } });
    const resolvedAt = new Date(String(proof['observedAt']));
    const reference = `mmg-terminal:${payment.id}:${String(proof['generation'])}`;
    await tx.paymentConfirmationHold.create({ data: { tenantId: clock.tenantId, subscriptionId: payment.subscriptionId,
      clockId: clock.id, sourceEpoch: clock.epoch, paymentId: payment.id, status: 'PROVEN_UNPAID', reason: 'MMG_PROVIDER_TERMINAL',
      beganAt: payment.createdAt, resolvedAt, resolvedBy: 'provider-confirmation', resolutionEvidence: reference,
      resolutionHistory: [{ status: 'PROVEN_UNPAID', at: resolvedAt.toISOString(), actor: 'provider-confirmation', reference, epoch: clock.epoch }],
      reviewDueAt: new Date(payment.createdAt.getTime() + FEE_RETRY_MS) } });
  }
  for (const source of sources) {
    await beginConfirmationInTx(tx, source.subscriptionId, source.source, source.reason,
      new Date(Math.min(source.at.getTime(), now.getTime())));
  }
}

export async function currentDunningClock(tx: Tx, subscriptionId: string, now = new Date(), discover = true) {
  subscriptionId = (await clockRow(tx, subscriptionId, now)).subscriptionId;
  if (discover) await discoverUnresolvedSources(tx, subscriptionId, now);
  const clock = await tx.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId } });
  await projectDunningClock(tx, clock, now);
  return clock;
}

export async function readDunningClock(db: PrismaClient, subscriptionId: string, now = new Date()) {
  return db.$transaction((tx) => currentDunningClock(tx, subscriptionId, now));
}

/** [CARDS S1] A card approval that arrived after its session was closed, held
 * for a person (LATE_PROVIDER_APPROVAL): the provider may hold this payer's
 * money. No new instruction is sent beside it — even when its confirmation
 * could not be reopened (a newer obligation) — until finance resolves it. */
export async function lateCardApprovalHeldInTx(tx: Tx | PrismaClient, sourceIds: string[]): Promise<boolean> {
  return !!await tx.cardSession.findFirst({ where: { subscriptionId: { in: sourceIds }, status: 'HELD', failureCode: 'LATE_PROVIDER_APPROVAL' }, select: { id: true } });
}

export async function hasConfirmationInTx(tx: Tx, subscriptionId: string, now: Date, except?: ConfirmationSource) {
  const clock = await currentDunningClock(tx, subscriptionId, now);
  subscriptionId = clock.subscriptionId;
  if (clock.authorityHoldReason) return true;
  // Every source FK is nullable. SQL NOT (checkoutId = id) also rejects a
  // card/payment row whose checkoutId is NULL, hiding another live rail.
  const otherSource = except ? Object.entries(except).map(([field, id]) => ({
    OR: [{ [field]: null }, { [field]: { not: id } }],
  })) : [];
  if (await tx.paymentConfirmationHold.findFirst({ where: {
    clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES }, AND: otherSource,
  }, select: { id: true } })) return true;
  // [R3] An MMG approval held for a person (MMG names a different or an
  // unverified transaction for a request) is money MMG may hold for the payer,
  // even when the request's own confirmation was already resolved (a captured
  // week). No new instruction while it is reviewed: a second or third charge
  // is never sent beside it. Reconciliation by a person clears the marker.
  const authority = await tx.moverFeeAuthority.findUnique({ where: { canonicalSubscriptionId: subscriptionId }, include: { members: true } });
  const sourceIds = authority?.members.map((m) => m.subscriptionId) ?? [subscriptionId];
  if (await lateCardApprovalHeldInTx(tx, sourceIds)) return true;
  const exceptPayment = except && 'paymentId' in except ? except.paymentId : undefined;
  return !!await tx.subscriptionPayment.findFirst({ where: {
    subscriptionId: { in: sourceIds }, paymentMethod: 'MOBILE_MONEY',
    ...(exceptPayment ? { id: { not: exceptPayment } } : {}),
    OR: [
      { failureCode: { in: ['SETTLEMENT_MISMATCH', 'HISTORY_APPROVAL_UNVERIFIED'] } },
      { failureRaw: { path: ['settlementHold'], equals: 'MMG_APPROVAL_MISMATCH' } },
      { failureRaw: { path: ['settlementHold'], equals: 'MMG_HISTORY_APPROVAL_UNVERIFIED' } },
    ],
  }, select: { id: true } });
}

/** A resolution never suspends. It only resumes the remaining schedule. The
 * next ordinary worker may enforce an already exhausted clock. */
export async function resolveConfirmationInTx(
  tx: Tx, subscriptionId: string, source: ConfirmationSource,
  resolution: ConfirmationResolution, evidence: { actor: string; reference: string }, now = new Date(),
) {
  const clock = await clockRow(tx, subscriptionId, now);
  subscriptionId = clock.subscriptionId;
  if (!evidence.actor.trim() || !evidence.reference.trim()) throw new AppError(400, 'PAYMENT_RESOLUTION_EVIDENCE_REQUIRED', 'Record the confirmation evidence.');
  const hold = await tx.paymentConfirmationHold.findFirst({ where: sourceWhere(source) });
  if (!hold) return null; // Pre-cutover proven terminal instructions may have no hold.
  if (hold.clockId !== clock.id) throw new NotFoundError('Payment confirmation', subscriptionId);
  if (!ACTIVE_CONFIRMATION_STATES.includes(hold.status)) return hold;
  const resolved = await tx.paymentConfirmationHold.update({ where: { id: hold.id }, data: {
    status: resolution, resolvedAt: now, resolvedBy: evidence.actor, resolutionEvidence: evidence.reference,
    resolutionHistory: [...(Array.isArray(hold.resolutionHistory) ? hold.resolutionHistory : []),
      { status: resolution, at: now.toISOString(), actor: evidence.actor, reference: evidence.reference, epoch: hold.sourceEpoch }] as Prisma.InputJsonValue,
  } });
  if (!clock.authorityHoldReason && !await tx.paymentConfirmationHold.findFirst({ where: { clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES } }, select: { id: true } })) {
    const prior = await tx.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId } });
    const resumed = resumeInstant(prior, now);
    const resumedClock = prior.pausedAt ? await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
      pausedAt: null, runningSince: new Date(Math.max(resumed.getTime(), prior.dueAt.getTime())),
      resumedAt: resumed, version: { increment: 1 },
    } }) : prior;
    await projectDunningClock(tx, resumedClock, now);
  }
  return resolved;
}

/** A late provider record that may be this partner's money, for a source whose pause
 * a previous negative already released, takes the pause again for a person: owner
 * decision 2, a HELD payment is never dunned. Only the SAME obligation is
 * paused again; an older instruction never restarts or extends a newer one.
 * The database admits exactly this transition (LATE_POSITIVE_REVIEW). */
export async function reopenConfirmationForReviewInTx(tx: Tx, subscriptionId: string, source: { checkoutId: string } | { cardSessionId: string }, reason: string, now: Date) {
  const clock = await clockRow(tx, subscriptionId, now);
  const hold = await tx.paymentConfirmationHold.findFirst({ where: sourceWhere(source) });
  if (!hold || hold.clockId !== clock.id || hold.status !== 'PROVEN_UNPAID' || hold.sourceEpoch !== clock.epoch) return hold;
  const reopened = await tx.paymentConfirmationHold.update({ where: { id: hold.id }, data: {
    status: 'ACTIVE', reason: 'LATE_POSITIVE_REVIEW', resolvedAt: null, resolvedBy: null, resolutionEvidence: null,
    reviewDueAt: new Date(now.getTime() + FEE_RETRY_MS), reviewNotifiedAt: null,
    resolutionHistory: [...(Array.isArray(hold.resolutionHistory) ? hold.resolutionHistory : []),
      { status: 'LATE_POSITIVE_REVIEW', at: now.toISOString(), reason, epoch: hold.sourceEpoch }] as Prisma.InputJsonValue,
  } });
  if (!clock.pausedAt) {
    const paused = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
      elapsedMs: BigInt(activeOverdueMs(clock, now)), runningSince: null, pausedAt: now, version: { increment: 1 },
    } });
    await projectDunningClock(tx, paused, now);
  }
  return reopened;
}

export async function markSettlementApplying(tx: Tx, subscriptionId: string, source: ConfirmationSource, now: Date) {
  const hold = await beginConfirmationInTx(tx, subscriptionId, source, 'SETTLEMENT_APPLY_PENDING', now);
  if (ACTIVE_CONFIRMATION_STATES.includes(hold.status)) {
    await tx.paymentConfirmationHold.update({ where: { id: hold.id }, data: { status: 'SETTLEMENT_APPLY_PENDING', reason: 'SETTLEMENT_APPLY_PENDING' } });
  } else if (hold.status === 'PROVEN_UNPAID' && 'checkoutId' in source) {
    const clock = await tx.billingDunningClock.findUniqueOrThrow({ where: { id: hold.clockId } });
    // An older instruction cannot restart or extend a newer obligation.
    if (hold.sourceEpoch !== clock.epoch) return;
    const checkout = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: source.checkoutId } });
    const { verifiedCheckoutCredit } = await import('./confirmation-finance');
    const proof = checkout.status === 'CONFIRMED' ? await verifiedCheckoutCredit(tx, checkout) : null;
    if (!proof) throw new AppError(409, 'SETTLEMENT_EVIDENCE_REQUIRED', 'The payment needs verified settlement evidence.');
    await tx.paymentConfirmationHold.update({ where: { id: hold.id }, data: {
      status: 'SETTLEMENT_APPLY_PENDING', reason: 'VERIFIED_POSITIVE_CORRECTION',
      resolvedAt: null, resolvedBy: null, resolutionEvidence: null,
      resolutionHistory: [...(Array.isArray(hold.resolutionHistory) ? hold.resolutionHistory : []),
        { status: 'VERIFIED_POSITIVE_CORRECTION', at: now.toISOString(), providerPaymentId: proof.identity.id,
          creditEventId: proof.creditEventId, epoch: hold.sourceEpoch }] as Prisma.InputJsonValue,
    } });
    if (!clock.pausedAt) {
      const paused = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
        elapsedMs: BigInt(activeOverdueMs(clock, now)), runningSince: null, pausedAt: now, version: { increment: 1 },
      } });
      await projectDunningClock(tx, paused, now);
    }
  }
}

/** `settledCurrency` is the currency the settlement booked its success record
 * in (its issue pin); the database repeats that pin check. */
export async function advanceDunningObligation(tx: Tx, subscriptionId: string, nextDue: Date, now: Date, settledCurrency?: string) {
  const previous = await clockRow(tx, subscriptionId, now);
  if (previous.subscriptionId !== subscriptionId) throw new AppError(409, 'MOVER_FEE_SOURCE_CHANGED', 'Use the current shared weekly fee.');
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const proof = await settledFeePeriodInTx(tx, sub, previous.dueAt, nextDue, settledCurrency ?? sub.currencyCode);
  if (!proof || sub.currentPeriodStart.getTime() !== previous.dueAt.getTime()
    || sub.currentPeriodEnd.getTime() !== nextDue.getTime() || sub.nextBillingDate.getTime() !== nextDue.getTime()) {
    throw new AppError(409, 'BILLING_OBLIGATION_REVIEW_REQUIRED', 'The weekly-fee obligation needs verified coverage before it can advance.');
  }
  await recordObligationTransition(tx, previous, sub, proof, 'PAID', nextDue, now);
  await tx.billingFeeNotice.updateMany({ where: { clockId: previous.id, epoch: previous.epoch, status: 'PENDING' }, data: { status: 'OBSOLETE' } });
  const held = previous.authorityHoldReason || await tx.paymentConfirmationHold.count({ where: { clockId: previous.id, status: { in: ACTIVE_CONFIRMATION_STATES } } });
  const clock = await tx.billingDunningClock.update({ where: { subscriptionId }, data: {
    dueAt: nextDue, epoch: { increment: 1 }, version: { increment: 1 }, elapsedMs: 0n,
    runningSince: held ? null : nextDue, pausedAt: held ? previous.pausedAt ?? now : null, resumedAt: null,
    retryAtMs: 0n, nudgeAtMs: null, churnAtMs: null,
  } });
  await projectDunningClock(tx, clock, now);
}

export async function resumeVoluntaryObligationInTx(tx: Tx, sub: Subscription, previous: BillingDunningClock, now: Date) {
  const proof = await voluntaryResumeProofInTx(tx, sub, previous);
  const lapse = proof && await voluntaryLapseInTx(tx, sub, previous, proof);
  if (!proof || !lapse) {
    await tx.auditLog.create({ data: { action: 'BILLING_OBLIGATION_REVIEW_REQUIRED', entity: 'BillingDunningClock', entityId: previous.id,
      changes: { clockId: previous.id, tenantId: previous.tenantId, subscriptionId: sub.id,
        epoch: previous.epoch, dueAt: previous.dueAt.toISOString(), reason: 'PAUSED_COVERAGE_UNPROVEN_OR_ALREADY_USED' } } });
    return false;
  }
  await recordObligationTransition(tx, previous, sub, proof, 'VOLUNTARY_RESUME', now, now, lapse.id);
  await tx.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', autoRenew: true, nextBillingDate: now, nextRetryAt: null } });
  await tx.billingFeeNotice.updateMany({ where: { clockId: previous.id, epoch: previous.epoch, status: 'PENDING' }, data: { status: 'OBSOLETE' } });
  const next = await tx.billingDunningClock.update({ where: { id: previous.id }, data: {
    dueAt: now, epoch: { increment: 1 }, version: { increment: 1 }, elapsedMs: 0n, runningSince: now,
    pausedAt: null, resumedAt: null, retryAtMs: 0n, nudgeAtMs: null, churnAtMs: null,
  } });
  await projectDunningClock(tx, next, now);
  return true;
}

export async function scheduleDunningFailure(tx: Tx, subscriptionId: string, now: Date) {
  const current = await currentDunningClock(tx, subscriptionId, now);
  subscriptionId = current.subscriptionId;
  if (current.pausedAt) throw new AppError(409, 'PAYMENT_CONFIRMING', 'The weekly-fee payment is being confirmed.');
  const elapsed = activeOverdueMs(current, now);
  const clock = await tx.billingDunningClock.update({ where: { subscriptionId }, data: { retryAtMs: BigInt(elapsed + FEE_RETRY_MS) } });
  await projectDunningClock(tx, clock, now);
  return { clock, elapsed, maySuspend: elapsed >= FULL_FEE_GRACE_MS && !resumedNoEarlierThan(current, now) };
}

/** A hosted session and its payment are one external instruction. */
export async function paymentConfirmationSource(tx: Tx, paymentId: string): Promise<ConfirmationSource> {
  const payment = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId }, select: { clientKey: true } });
  return payment.clientKey?.startsWith('cardpay:')
    ? { cardSessionId: payment.clientKey.slice('cardpay:'.length) } : { paymentId };
}
export async function resolvePaymentConfirmationInTx(
  tx: Tx, subscriptionId: string, paymentId: string, resolution: ConfirmationResolution,
  evidence: { actor: string; reference: string }, now: Date,
) {
  return resolveConfirmationInTx(tx, subscriptionId, await paymentConfirmationSource(tx, paymentId), resolution, evidence, now);
}
