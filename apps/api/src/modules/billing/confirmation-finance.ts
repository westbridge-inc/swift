import type { MmgCheckoutIntent, Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { ACTIVE_CONFIRMATION_STATES, activeOverdueMs, currentDunningClock, FULL_FEE_GRACE_MS, markSettlementApplying, resolveConfirmationInTx } from './dunning-clock';
import type { OnAudit } from '../../lib/audit-writer';

/** An existing credit, bound to this checkout's exact instruction and owner.
 * A manual PAID checkbox alone never creates or proves a money movement. */
export async function verifiedCheckoutCredit(tx: Prisma.TransactionClient, checkout: MmgCheckoutIntent, providerPaymentId = checkout.providerPaymentId) {
  if (!providerPaymentId || (checkout.providerPaymentId && providerPaymentId !== checkout.providerPaymentId)) return null;
  const refs = [...checkout.candidates, ...(checkout.mmgTransactionId ? [checkout.mmgTransactionId] : [])];
  const identities = await tx.$queryRaw<Array<{ id: string; providerTxnId: string; creditedPaymentId: string }>>`
    SELECT p.id,p."providerTxnId",p."creditedPaymentId" FROM provider_payments p
    WHERE p.id=${providerPaymentId} AND p.provider='MMG' AND p.status='CREDITED'
      AND p."tenantId"=${checkout.tenantId} AND p."subscriptionId"=${checkout.subscriptionId}
      AND p.amount=${checkout.amount} AND p."currencyCode"=${checkout.currencyCode}
      AND EXISTS (SELECT 1 FROM unnest(${refs}::text[]) r WHERE mmg_txn_canon(r)=mmg_txn_canon(p."providerTxnId")) FOR UPDATE`;
  const identity = identities[0];
  if (!identity) return null;
  const [event] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT ev.id FROM billing_events ev WHERE ev."subscriptionId"=${checkout.subscriptionId}
      AND ev.type='PREPAID_TOPUP' AND ev.amount=${checkout.amount} AND ev."currencyCode"=${checkout.currencyCode}
      AND ((ev."idempotencyKey"='mmg-checkout:pp:'||${identity.id} AND ${identity.creditedPaymentId}='mco:'||${checkout.id})
        OR (ev."idempotencyKey"='agent-cash:pp:'||${identity.id} AND EXISTS (
          SELECT 1 FROM mmg_agent_payments ap WHERE ap.id=${identity.creditedPaymentId} AND ap."providerPaymentId"=${identity.id}))
        OR EXISTS (SELECT 1 FROM topup_commands tc WHERE tc."billingEventId"=ev.id
          AND 'topup:'||tc."adminId"||':'||tc."idempotencyKey"=${identity.creditedPaymentId})) LIMIT 1`;
  return event ? { identity, creditEventId: event.id } : null;
}

export async function confirmationReviewQueue(db: PrismaClient, tenantId: string, now = new Date()) {
  const holds = await db.paymentConfirmationHold.findMany({ where: { tenantId, status: { in: ACTIVE_CONFIRMATION_STATES } },
    orderBy: [{ reviewDueAt: 'asc' }, { id: 'asc' }], take: 200, include: { clock: true } });
  const payments = holds.map((hold) => ({
    id: hold.id, subscriptionId: hold.subscriptionId, epoch: hold.sourceEpoch, clockEpoch: hold.clock.epoch,
    clockVersion: hold.clock.version, status: hold.status, resolvable: true,
    source: hold.checkoutId ? 'MMG_CHECKOUT' : hold.cardSessionId ? 'CARD_SESSION' : 'PAYMENT',
    sourceId: hold.checkoutId ?? hold.cardSessionId ?? hold.paymentId,
    reason: hold.reason, beganAt: hold.beganAt, reviewDueAt: hold.reviewDueAt, overdue: hold.reviewDueAt <= now,
    remainingGraceMs: Math.max(0, FULL_FEE_GRACE_MS - activeOverdueMs(hold.clock, now)),
  }));
  // A legacy PAUSED obligation is a review item, not a provider confirmation.
  // It cannot acquire a PAID/UNPAID override through the hold resolver.
  const clocks = await db.billingDunningClock.findMany({ where: { tenantId, subscription: { status: 'PAUSED' } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 200 });
  const byId = new Map(clocks.map((clock) => [clock.id, clock]));
  const audits = clocks.length ? await db.auditLog.findMany({ where: { entity: 'BillingDunningClock',
    entityId: { in: clocks.map((clock) => clock.id) }, action: 'BILLING_OBLIGATION_REVIEW_REQUIRED' },
    distinct: ['entityId'], orderBy: { createdAt: 'desc' }, take: 200 }) : [];
  const obligations = audits.flatMap((audit) => {
    const clock = byId.get(audit.entityId);
    const facts = audit.changes as Prisma.JsonObject | null;
    if (!clock || facts?.['tenantId'] !== tenantId || facts['clockId'] !== clock.id
      || facts['subscriptionId'] !== clock.subscriptionId || facts['epoch'] !== clock.epoch
      || facts['dueAt'] !== clock.dueAt.toISOString()) return [];
    return [{ id: audit.id, subscriptionId: clock.subscriptionId, epoch: clock.epoch, clockEpoch: clock.epoch,
      clockVersion: clock.version, status: 'REVIEW_REQUIRED', resolvable: false, source: 'OBLIGATION', sourceId: clock.subscriptionId,
      reason: 'PAUSED_COVERAGE_UNPROVEN_OR_ALREADY_USED', beganAt: audit.createdAt, reviewDueAt: audit.createdAt, overdue: true,
      remainingGraceMs: Math.max(0, FULL_FEE_GRACE_MS - activeOverdueMs(clock, now)) }];
  });
  return [...payments, ...obligations];
}

export async function resolveFinanceConfirmation(db: PrismaClient, input: {
  id: string; tenantId: string; actorId: string; sourceId: string; epoch: number; clockVersion: number;
  decision: 'UNPAID' | 'PAID'; evidenceReference: string; providerPaymentId?: string;
}, onAudit: OnAudit, now = new Date()) {
  return db.$transaction(async (tx) => {
    const candidate = await tx.paymentConfirmationHold.findFirst({ where: { id: input.id, tenantId: input.tenantId } });
    if (!candidate) throw new NotFoundError('Payment confirmation', input.id);
    const clock = await currentDunningClock(tx, candidate.subscriptionId, now);
    const hold = await tx.paymentConfirmationHold.findUniqueOrThrow({ where: { id: input.id } });
    const sourceId = hold.checkoutId ?? hold.cardSessionId ?? hold.paymentId;
    if (hold.tenantId !== input.tenantId || sourceId !== input.sourceId) throw new NotFoundError('Payment confirmation', input.id);
    if (!ACTIVE_CONFIRMATION_STATES.includes(hold.status)) return { id: hold.id, subscriptionId: hold.subscriptionId, status: hold.status, changed: false };
    if (hold.sourceEpoch !== input.epoch || clock.epoch !== input.epoch || clock.version !== input.clockVersion) {
      throw new AppError(409, 'CONFIRMATION_CHANGED', 'Reload the payment confirmation before resolving it.');
    }
    const evidence = { actor: input.actorId, reference: input.evidenceReference };
    const conflict = () => new AppError(409, 'SETTLEMENT_EVIDENCE_REQUIRED', 'Complete or reconcile this payment through its existing settlement workflow first.');
    if (hold.checkoutId) {
      const source = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: hold.checkoutId } });
      if (input.decision === 'PAID') {
        const proof = await verifiedCheckoutCredit(tx, source, input.providerPaymentId);
        if (!proof) throw conflict();
        await tx.mmgCheckoutIntent.update({ where: { id: source.id }, data: { status: 'CONFIRMED', providerPaymentId: proof.identity.id,
          mmgTransactionId: proof.identity.providerTxnId, confirmedAt: now, nextCheckAt: null, reason: null } });
        await markSettlementApplying(tx, hold.subscriptionId, { checkoutId: source.id }, now);
      } else {
        if (source.status === 'CONFIRMED' || source.providerPaymentId) throw conflict();
        await tx.mmgCheckoutIntent.update({ where: { id: source.id }, data: { status: 'NOT_PAID', nextCheckAt: null, reason: 'FINANCE_CONFIRMED_UNPAID' } });
        await resolveConfirmationInTx(tx, hold.subscriptionId, { checkoutId: source.id }, 'PROVEN_UNPAID', evidence, now);
      }
    } else {
      const session = hold.cardSessionId ? await tx.cardSession.findUniqueOrThrow({ where: { id: hold.cardSessionId } }) : null;
      const paymentId = hold.paymentId ?? session?.paymentId;
      const payment = paymentId ? await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } }) : null;
      const source = hold.cardSessionId ? { cardSessionId: hold.cardSessionId } : { paymentId: hold.paymentId! };
      if (input.decision === 'PAID') {
        if (!payment || payment.status !== 'CAPTURED' || payment.subscriptionId !== hold.subscriptionId) throw conflict();
        const booked = await tx.billingEvent.findFirst({ where: { subscriptionId: hold.subscriptionId, amount: payment.amount,
          OR: [{ idempotencyKey: `bank:${payment.id}` }, { type: 'CHARGE_SUCCESS', paymentRef: payment.externalRef }] } });
        const key = payment.clientKey;
        const attempt = key && (key.startsWith('card:') || key.startsWith('sub:'))
          ? await tx.billingEvent.findUnique({ where: { idempotencyKey: `charge:${key.slice(key.startsWith('card:') ? 5 : 4)}` } }) : null;
        const currency = session?.currencyCode ?? attempt?.currencyCode;
        if (!booked || !payment.externalRef || !currency || booked.currencyCode !== currency
          || (session && (!session.amount?.equals(payment.amount) || session.subscriptionId !== hold.subscriptionId))) throw conflict();
        await resolveConfirmationInTx(tx, hold.subscriptionId, source, 'PAID', evidence, now);
      } else {
        const raw = payment?.failureRaw as Record<string, unknown> | null;
        if (session?.status === 'SUCCEEDED' || payment?.status === 'CAPTURED' || raw?.['providerOutcome'] === 'CAPTURED'
          || hold.status === 'SETTLEMENT_APPLY_PENDING') throw conflict();
        if (session) await tx.cardSession.update({ where: { id: session.id }, data: { status: 'FAILED', failureCode: 'FINANCE_CONFIRMED_UNPAID', confirmedAt: now } });
        if (payment) await tx.subscriptionPayment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureCode: 'DECLINED',
          failureRaw: { ...(raw ?? {}), providerOutcome: 'DECLINED', financeConfirmationId: hold.id, observedAt: now.toISOString() } as Prisma.InputJsonValue } });
        await resolveConfirmationInTx(tx, hold.subscriptionId, source, 'PROVEN_UNPAID', evidence, now);
      }
    }
    const resolved = await tx.paymentConfirmationHold.findUniqueOrThrow({ where: { id: hold.id } });
    await onAudit(tx, { confirmationId: hold.id, subscriptionId: hold.subscriptionId, sourceId, epoch: hold.sourceEpoch,
      decision: input.decision, evidenceReference: input.evidenceReference, status: resolved.status });
    return { id: hold.id, subscriptionId: hold.subscriptionId, status: resolved.status, changed: true };
  });
}
