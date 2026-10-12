import { billingEffectsReady } from '../billing/billing-cutover';
import type { Prisma, PrismaClient, Subscription } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { bindTenantTransaction } from '../../plugins/prisma';
import { moverSourceFinancialFingerprint, paidMoverResolutionBlocker } from './mover-fee-history';
import { capabilitiesOf, holdsCapability } from '../admin/admin-authority';
import { partnerRateFor, subscriptionTiersIn } from '../country/country-config.service';

type Db = PrismaClient | Prisma.TransactionClient;

export interface SubscriptionPayer {
  userId: string;
  tenantId: string;
  kind: 'MOVER' | 'VENDOR';
}

export interface MoverFeeResolution {
  payerUserId: string;
  tenantId: string;
  canonicalSubscriptionId: string;
  sourceSubscriptionIds: string[];
  state: 'ACTIVE' | 'FINANCE_HOLD';
  holdReason: string | null;
  feeType: Subscription['type'];
  revision: number;
}

const ownershipError = () => new AppError(409, 'MOVER_FEE_OWNERSHIP_INVALID', 'The weekly fee needs an ownership check before it can be changed.');

/** Resolve the original owner of a money record without choosing a new payer.
 * Historical provider work must keep this subscription and owner binding. */
export async function subscriptionPayer(db: Db, subscriptionId: string): Promise<SubscriptionPayer> {
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      riderId: true, driverId: true, vendorId: true,
      rider: { select: { user: { select: { id: true, tenantId: true } } } },
      driver: { select: { user: { select: { id: true, tenantId: true } } } },
      vendor: { select: { tenantId: true, owner: { select: { user: { select: { id: true, tenantId: true } } } } } },
    },
  });
  if (!sub || [sub.riderId, sub.driverId, sub.vendorId].filter(Boolean).length !== 1) throw ownershipError();
  const user = sub.rider?.user ?? sub.driver?.user ?? sub.vendor?.owner.user;
  if (!user) throw ownershipError();
  return { userId: user.id, tenantId: user.tenantId, kind: sub.vendorId ? 'VENDOR' : 'MOVER' };
}

/** The common lock order for activation, collection, settings and outcomes:
 * payer User, then all of that payer's mover subscriptions sorted by ID.
 * Wallet, provider, session and clock rows may be locked only afterwards. */
export async function lockMoverSources(
  tx: Prisma.TransactionClient,
  payer: { userId: string; tenantId: string },
): Promise<Subscription[]> {
  await bindTenantTransaction(tx);
  const users = await tx.$queryRaw<Array<{ id: string; tenantId: string }>>`
    SELECT "id", "tenantId" FROM "users" WHERE "id" = ${payer.userId} FOR UPDATE
  `;
  if (users.length !== 1 || users[0]!.tenantId !== payer.tenantId) throw ownershipError();

  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT s."id" FROM "subscriptions" s
    LEFT JOIN "riders" r ON r."id" = s."riderId"
    LEFT JOIN "drivers" d ON d."id" = s."driverId"
    WHERE r."userId" = ${payer.userId} OR d."userId" = ${payer.userId}
    ORDER BY s."id" FOR UPDATE OF s
  `;
  const subscriptions = await tx.subscription.findMany({
    where: { id: { in: rows.map((r) => r.id) } }, orderBy: { id: 'asc' },
  });
  for (const sub of subscriptions) {
    const owner = await subscriptionPayer(tx, sub.id);
    if (owner.kind !== 'MOVER' || owner.userId !== payer.userId || owner.tenantId !== payer.tenantId) throw ownershipError();
  }
  return subscriptions;
}

/** Vendor subscriptions keep their separate business identity. Movers share
 * their payer lock across both profiles, including historical source rows. */
export async function lockSubscriptionPayer(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
): Promise<SubscriptionPayer> {
  await bindTenantTransaction(tx);
  const payer = await subscriptionPayer(tx, subscriptionId);
  if (payer.kind === 'MOVER') {
    const sources = await lockMoverSources(tx, payer);
    if (!sources.some((s) => s.id === subscriptionId)) throw ownershipError();
  } else {
    const users = await tx.$queryRaw<Array<{ tenantId: string }>>`
      SELECT "tenantId" FROM "users" WHERE "id" = ${payer.userId} FOR UPDATE
    `;
    if (users.length !== 1 || users[0]!.tenantId !== payer.tenantId) throw ownershipError();
    await tx.$queryRaw`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`;
    const fresh = await subscriptionPayer(tx, subscriptionId);
    if (fresh.kind !== payer.kind || fresh.userId !== payer.userId || fresh.tenantId !== payer.tenantId) throw ownershipError();
  }
  return payer;
}

/** A zero wallet does not erase a prior instruction, receipt or ledger. */
async function hasFinancialHistory(db: Db, sources: Subscription[]): Promise<boolean> {
  if (!sources.length) return false;
  const ids = sources.map((s) => s.id);
  const sans = sources.flatMap((s) => s.san ? [s.san] : []);
  const linked = { subscriptionId: { in: ids } };
  const evidence = await Promise.all([
    db.subscriptionPayment.findFirst({ where: linked, select: { id: true } }),
    db.subscriptionRefund.findFirst({ where: linked, select: { id: true } }),
    db.billingEvent.findFirst({ where: linked, select: { id: true } }),
    db.topUpCommand.findFirst({ where: linked, select: { id: true } }),
    db.providerPayment.findFirst({ where: linked, select: { id: true } }),
    db.feeReceipt.findFirst({ where: linked, select: { id: true } }),
    db.collectionContact.findFirst({ where: linked, select: { id: true } }),
    db.paymentInstrument.findFirst({ where: linked, select: { id: true } }),
    db.cardSession.findFirst({ where: linked, select: { id: true } }),
    db.mmgCheckoutIntent.findFirst({ where: linked, select: { id: true } }),
    db.cardObservation.findFirst({ where: linked, select: { id: true } }),
    db.ledgerEntry.findFirst({ where: { subledgerId: { in: ids } }, select: { id: true } }),
    db.ledgerTransaction.findFirst({ where: { OR: ids.flatMap((id) => [
      { idempotencyKey: `opening:${id}` },
      { idempotencyKey: { startsWith: `ledger:success:${id}:` } },
      { idempotencyKey: { startsWith: `ledger:topup:${id}:` } },
    ]) }, select: { id: true } }),
    db.sanTombstone.findFirst({ where: { OR: [linked, { san: { in: sans } }] }, select: { san: true } }),
    db.mmgAgentPayment.findFirst({ where: { OR: [linked, { sanNormalized: { in: sans } }] }, select: { id: true } }),
  ]);
  if (evidence.some(Boolean)) return true;
  const balances = await db.prepaidBalance.findMany({ where: linked, select: { subscriptionId: true, balance: true, currencyCode: true } });
  if (balances.some((b) => !b.balance.equals(0) || b.currencyCode !== sources.find((s) => s.id === b.subscriptionId)!.currencyCode)) return true;
  // Normalize legacy references on the server without retrieving payloads.
  for (const san of sans) {
    const rows = await db.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM mmg_agent_payments WHERE regexp_replace("sanRaw", '[^0-9]', '', 'g') = ${san}
        UNION ALL
        SELECT 1 FROM settlement_imports i, jsonb_array_elements(i.rows) r
        WHERE regexp_replace(r->>'sanRaw', '[^0-9]', '', 'g') = ${san}
      ) AS found
    `;
    if (rows[0]?.found) return true;
  }
  return false;
}

function compatibleEmptyTrials(sources: Subscription[]): boolean {
  const first = sources[0]!;
  const time = (d: Date | null) => d?.getTime() ?? null;
  return sources.every((s) => s.status === 'TRIAL' && s.isTrialActive && s.autoRenew && s.autoSuspendEnabled
    && !s.isInGracePeriod && !s.gracePeriodEnd && !s.suspendedAt && !s.nextRetryAt
    && !s.failedAttempts && !s.lastPaymentId && !s.lastPaymentDate
    && s.customRate === null && !s.feeWaived && !s.feeWaivedBy && !s.feeWaivedReason
    && s.billingMethod === 'CASH' && !s.paymentToken && !s.mmgPayerMsisdn
    && s.currencyCode === first.currencyCode
    && time(s.currentPeriodStart) === time(first.currentPeriodStart)
    && time(s.currentPeriodEnd) === time(first.currentPeriodEnd)
    && time(s.nextBillingDate) === time(first.nextBillingDate)
    && time(s.trialEndDate) === time(first.trialEndDate));
}

async function sourceProjection(db: Db, payer: { userId: string; tenantId: string }, sources: Subscription[]): Promise<MoverFeeResolution | null> {
  if (!sources.length) return null;
  const persisted = await db.moverFeeAuthority.findUnique({ where: { userId: payer.userId }, include: { members: true } });
  const ids = sources.map((s) => s.id).sort();
  if (persisted) {
    if (persisted.tenantId !== payer.tenantId || !ids.includes(persisted.canonicalSubscriptionId)) throw ownershipError();
    const knownIds = persisted.members.map((m) => m.subscriptionId).sort();
    const addedSource = JSON.stringify(knownIds) !== JSON.stringify(ids);
    const aliases = sources.filter((s) => s.id !== persisted.canonicalSubscriptionId);
    let aliasMoney = persisted.state === 'ACTIVE' && !addedSource && await hasFinancialHistory(db, aliases);
    if (aliasMoney) {
      const decision = await db.auditLog.findFirst({
        where: { entity: 'MoverFeeAuthority', entityId: payer.userId, action: 'MOVER_FEE_RESOLVED' },
        orderBy: { createdAt: 'desc' }, select: { changes: true },
      });
      const facts = decision?.changes as Prisma.JsonObject | undefined;
      const acknowledgments = facts?.['aliasEvidence'] as Prisma.JsonObject | undefined;
      if (facts?.['tenantId'] === payer.tenantId && facts?.['canonicalSubscriptionId'] === persisted.canonicalSubscriptionId
        && acknowledgments && Object.keys(acknowledgments).sort().join(',') === aliases.map((a) => a.id).sort().join(',')) {
        const unchanged = await Promise.all(aliases.map(async (a) => acknowledgments[a.id] === await moverSourceFinancialFingerprint(db, a)));
        aliasMoney = !unchanged.every(Boolean);
      }
    }
    return {
      payerUserId: payer.userId, tenantId: payer.tenantId,
      canonicalSubscriptionId: persisted.canonicalSubscriptionId, sourceSubscriptionIds: ids,
      feeType: persisted.feeType, revision: persisted.revision,
      state: addedSource || aliasMoney ? 'FINANCE_HOLD' : persisted.state,
      holdReason: addedSource ? 'UNREGISTERED_MOVER_SOURCE' : aliasMoney ? 'HISTORICAL_SOURCE_MONEY' : persisted.holdReason,
    };
  }
  const canonical = sources.find((s) => s.driverId) ?? [...sources].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]!;
  if (!['TAXI_DRIVER', 'DELIVERY_RIDER', 'COURIER_RIDER'].includes(canonical.type)) throw ownershipError();
  const ambiguous = sources.length > 1 && (!compatibleEmptyTrials(sources) || await hasFinancialHistory(db, sources));
  return {
    payerUserId: payer.userId, tenantId: payer.tenantId,
    canonicalSubscriptionId: canonical.id, sourceSubscriptionIds: ids,
    feeType: canonical.type, revision: 0,
    state: ambiguous ? 'FINANCE_HOLD' : 'ACTIVE', holdReason: ambiguous ? 'LEGACY_MOVER_FINANCIAL_REVIEW' : null,
  };
}

async function persistDecision(
  tx: Prisma.TransactionClient,
  resolution: MoverFeeResolution,
  action: 'MOVER_FEE_CLASSIFIED' | 'MOVER_FEE_ACTIVATED' | 'MOVER_FEE_HELD' | 'MOVER_FEE_RESOLVED',
  actorUserId: string | null = null,
  evidence: Prisma.InputJsonObject = {},
): Promise<MoverFeeResolution> {
  const revision = resolution.revision + 1;
  const { payerUserId, sourceSubscriptionIds, ...facts } = { ...resolution, revision };
  const decision = await tx.auditLog.create({ data: {
    userId: actorUserId, action, entity: 'MoverFeeAuthority', entityId: payerUserId,
    changes: { ...evidence, ...facts, sourceSubscriptionIds },
  } });
  const data = {
    tenantId: resolution.tenantId, canonicalSubscriptionId: resolution.canonicalSubscriptionId,
    feeType: resolution.feeType, state: resolution.state, holdReason: resolution.holdReason,
    revision, decisionId: decision.id,
  };
  await tx.moverFeeAuthority.upsert({ where: { userId: payerUserId }, create: { userId: payerUserId, ...data }, update: data });
  await tx.moverFeeSubscription.createMany({
    data: sourceSubscriptionIds.map((subscriptionId) => ({ subscriptionId, userId: payerUserId, tenantId: resolution.tenantId })), skipDuplicates: true,
  });
  const result = { ...resolution, revision };
  const { syncMoverDunningAuthorityInTx } = await import('../billing/dunning-clock');
  await syncMoverDunningAuthorityInTx(tx, result);
  return result;
}

/** Authorized mutations persist classification under User -> sorted sources. */
export async function lockMoverFeeAuthority(tx: Prisma.TransactionClient, payer: { userId: string; tenantId: string }): Promise<MoverFeeResolution | null> {
  const sources = await lockMoverSources(tx, payer);
  const resolution = await sourceProjection(tx, payer, sources);
  if (!resolution) return null;
  const current = await tx.moverFeeAuthority.findUnique({ where: { userId: payer.userId }, include: { members: true } });
  if (!current || current.state !== resolution.state || current.holdReason !== resolution.holdReason
    || current.members.map((m) => m.subscriptionId).sort().join(',') !== resolution.sourceSubscriptionIds.join(',')) {
    return persistDecision(tx, resolution, current ? 'MOVER_FEE_HELD' : 'MOVER_FEE_CLASSIFIED');
  }
  return resolution;
}

/** GET paths only project legacy ambiguity; they never change financial state. */
export async function resolveMoverFeeAuthority(db: Db, payer: { userId: string; tenantId: string }): Promise<MoverFeeResolution | null> {
  if ('$transaction' in db) return db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    return resolveMoverFeeAuthority(tx, payer);
  });
  const user = await db.user.findUnique({ where: { id: payer.userId }, select: { tenantId: true } });
  if (!user || user.tenantId !== payer.tenantId) throw ownershipError();
  const sources = await db.subscription.findMany({ where: { OR: [{ rider: { userId: payer.userId } }, { driver: { userId: payer.userId } }] }, orderBy: { id: 'asc' } });
  for (const source of sources) {
    const owner = await subscriptionPayer(db, source.id);
    if (owner.kind !== 'MOVER' || owner.userId !== payer.userId || owner.tenantId !== payer.tenantId) throw ownershipError();
  }
  return sourceProjection(db, payer, sources);
}

/** Only activation grants taxi fee entitlement; an onboarding profile cannot. */
export async function activateMoverFeeType(tx: Prisma.TransactionClient, payer: { userId: string; tenantId: string }, feeType: Subscription['type']): Promise<MoverFeeResolution | null> {
  const current = await lockMoverFeeAuthority(tx, payer);
  if (!current || current.feeType === feeType || current.feeType === 'TAXI_DRIVER') return current;
  return persistDecision(tx, { ...current, feeType }, 'MOVER_FEE_ACTIVATED', payer.userId);
}

/** Decide NEW collection authority; never redirect historical settlement. */
export async function lockFeeCollectionAuthority(tx: Prisma.TransactionClient, subscriptionId: string): Promise<{ allowed: boolean; mover: MoverFeeResolution | null }> {
  const payer = await lockSubscriptionPayer(tx, subscriptionId);
  const ready = await billingEffectsReady(tx);
  if (payer.kind === 'VENDOR') return { allowed: ready, mover: null };
  const mover = await lockMoverFeeAuthority(tx, payer);
  return { allowed: ready && !!mover && mover.state === 'ACTIVE' && mover.canonicalSubscriptionId === subscriptionId, mover };
}

/** Read-only counterpart for forecasts and price disclosures. Callers that
 * create money effects still need the locked decision above. */
export async function readFeeCollectionAuthority(db: Db, subscriptionId: string): Promise<{ allowed: boolean; canonical: boolean; mover: MoverFeeResolution | null }> {
  try {
    const payer = await subscriptionPayer(db, subscriptionId);
    if (payer.kind === 'VENDOR') return { allowed: true, canonical: true, mover: null };
    const mover = await resolveMoverFeeAuthority(db, payer);
    const canonical = !!mover && mover.canonicalSubscriptionId === subscriptionId;
    return { allowed: canonical && mover?.state === 'ACTIVE', canonical, mover };
  } catch (error) {
    // Retention may leave an original financial source after its payer is
    // purged. It has no new tariff or collection authority; keep its history.
    if (error instanceof AppError && error.code === 'MOVER_FEE_OWNERSHIP_INVALID') return { allowed: false, canonical: false, mover: null };
    throw error;
  }
}

/** Authenticated readers use one canonical view while retaining each original
 * financial source for review. No classification or SAN assignment happens here. */
export async function readMoverFeeSubscription(db: Db, payer: { userId: string; tenantId: string }) {
  const authority = await resolveMoverFeeAuthority(db, payer);
  if (!authority) return null;
  const sources = await db.subscription.findMany({
    where: { id: { in: authority.sourceSubscriptionIds } }, orderBy: { id: 'asc' },
    include: { payments: { orderBy: { createdAt: 'desc' }, take: 20 }, prepaidBalance: true },
  });
  const canonical = sources.find((s) => s.id === authority.canonicalSubscriptionId);
  if (!canonical) throw ownershipError();
  return { authority, sources, subscription: { ...canonical, originalType: canonical.type, type: authority.feeType } };
}

export async function moverFeeOperability(
  db: Db, payer: { userId: string; tenantId: string },
  opts: { missingRow: 'BLOCK' | 'GRANDFATHER' }, now = new Date(),
) {
  const { subscriptionOperability } = await import('./operate-gate');
  const { activeDeadline, FULL_FEE_GRACE_MS } = await import('../billing/dunning-clock');
  const view = await readMoverFeeSubscription(db, payer);
  if (!view) return subscriptionOperability(null, opts, now);
  const clock = await db.billingDunningClock.findUnique({ where: { subscriptionId: view.authority.canonicalSubscriptionId } });
  const ready = await billingEffectsReady(db);
  // A finance hold grants no permission and creates no new suspension. Every
  // original restriction remains effective, so changing roles cannot evade it.
  for (const source of view.sources) {
    const pausedAt = !ready || !clock || view.authority.state === 'FINANCE_HOLD'
      ? clock?.pausedAt ?? source.billingConfirmationPausedAt ?? now : clock.pausedAt;
    const gated = { ...source, billingConfirmationPausedAt: pausedAt,
      billingEnforcementDueAt: clock && ready && !clock.pausedAt
        ? activeDeadline(clock, FULL_FEE_GRACE_MS, now) : null, gracePeriodEnd: null };
    const result = subscriptionOperability(gated, opts, now);
    if (!result.operable) return result;
  }
  // Every source, including canonical, passed. FINANCE_HOLD cannot create a
  // new billing denial from an elapsed but unapplied grace timer.
  return { operable: true as const };
}

export async function moverFeeSourceSummary(db: Db, payer: { userId: string; tenantId: string }) {
  const view = await readMoverFeeSubscription(db, payer);
  if (!view) return null;
  const { amountDueNow } = await import('../billing/amount-due');
  return {
    state: view.authority.state, holdReason: view.authority.holdReason,
    canonicalSubscriptionId: view.authority.canonicalSubscriptionId, feeType: view.authority.feeType,
    sources: await Promise.all(view.sources.map(async (s) => ({
      subscriptionId: s.id, originalType: s.type, status: s.status,
      weeklyRate: Number(s.weeklyRate), currencyCode: s.currencyCode,
      balance: Number(s.prepaidBalance?.balance ?? 0), amountDueNow: await amountDueNow(db, s),
      issuedCharges: s.payments.map((p) => ({ id: p.id, amount: Number(p.amount), status: p.status, periodStart: p.periodStart, periodEnd: p.periodEnd })),
    }))),
  };
}

export async function moverFeePayer(db: Db, userId: string): Promise<{ userId: string; tenantId: string }> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!user) throw ownershipError();
  return { userId, tenantId: user.tenantId };
}

/** Effective pricing follows activated entitlement, while every money record
 * continues to name its original Subscription.type and profile. */
export async function moverFeeTariffSubject(db: Db, authority: MoverFeeResolution) {
  const user = await db.user.findUniqueOrThrow({ where: { id: authority.payerUserId }, select: { countryCode: true, tenantId: true } });
  if (user.tenantId !== authority.tenantId) throw ownershipError();
  if (authority.feeType === 'TAXI_DRIVER') {
    const driver = await db.driver.findUniqueOrThrow({ where: { userId: authority.payerUserId }, select: { vehicleType: true } });
    return { countryCode: user.countryCode, subject: { kind: 'DRIVER' as const, vehicleType: driver.vehicleType } };
  }
  const rider = await db.rider.findUniqueOrThrow({ where: { userId: authority.payerUserId }, select: { vehicleType: true } });
  return { countryCode: user.countryCode, subject: { kind: 'RIDER' as const, vehicleType: rider.vehicleType } };
}

/** A bounded finance decision: no balance movement, refund, waiver or period
 * rewrite. The route supplies current finance capability and approval; this
 * transaction rechecks exact facts and writes the immutable decision itself. */
export async function resolveMoverFeeHold(
  tx: Prisma.TransactionClient,
  payer: { userId: string; tenantId: string },
  input: { expectedRevision: number; sourceSubscriptionIds: string[]; canonicalSubscriptionId: string; actorUserId: string; approvalId: string },
): Promise<MoverFeeResolution> {
  await bindTenantTransaction(tx);
  const actor = await tx.user.findUnique({ where: { id: input.actorUserId }, select: { roles: true, status: true, tenantId: true, admin: { select: { permissions: true } } } });
  const role = actor?.roles.includes('SUPER_ADMIN') ? 'SUPER_ADMIN' : actor?.roles.includes('ADMIN') ? 'ADMIN' : null;
  if (!actor || actor.status !== 'ACTIVE' || actor.tenantId !== payer.tenantId || !role
    || !holdsCapability(capabilitiesOf({ role, permissions: actor.admin?.permissions }), 'billing.payment.attach')) {
    throw new AppError(403, 'FORBIDDEN', 'Current finance authority is required for this review.');
  }
  const authority = await lockMoverFeeAuthority(tx, payer);
  if (!authority || authority.state !== 'FINANCE_HOLD' || authority.revision !== input.expectedRevision) {
    throw new AppError(409, 'MOVER_FEE_DECISION_STALE', 'The weekly fee review changed. Reload the current source facts.');
  }
  await tx.$queryRaw`SELECT id FROM privileged_approvals WHERE id=${input.approvalId} FOR UPDATE`;
  const approval = await tx.privilegedApproval.findUnique({ where: { id: input.approvalId } });
  const snapshot = approval?.bodySnapshot as Prisma.JsonObject | undefined;
  const body = snapshot?.['body'] as Prisma.JsonObject | undefined;
  const params = snapshot?.['params'] as Prisma.JsonObject | undefined;
  const approvedSources = body?.['sourceSubscriptionIds'];
  if (!approval || approval.tenantId !== payer.tenantId || approval.status !== 'APPLIED'
    || !approval.appliedAt || approval.expiresAt.getTime() <= Date.now()
    || approval.requestedBy !== input.actorUserId || !approval.approvedBy || approval.approvedBy === input.actorUserId
    || approval.action !== 'POST /billing/mover-fees/:userId/resolve' || approval.capability !== 'billing.payment.attach'
    || params?.['userId'] !== payer.userId || body?.['expectedRevision'] !== input.expectedRevision
    || body?.['canonicalSubscriptionId'] !== input.canonicalSubscriptionId || !Array.isArray(approvedSources)
    || JSON.stringify([...approvedSources].sort()) !== JSON.stringify([...input.sourceSubscriptionIds].sort())) {
    throw new AppError(403, 'MOVER_FEE_APPROVAL_REQUIRED', 'This exact finance decision needs a current independent approval.');
  }
  const approver = await tx.user.findUnique({ where: { id: approval.approvedBy }, select: { roles: true, status: true, tenantId: true, admin: { select: { permissions: true } } } });
  const approverRole = approver?.roles.includes('SUPER_ADMIN') ? 'SUPER_ADMIN' : approver?.roles.includes('ADMIN') ? 'ADMIN' : null;
  if (!approver || approver.status !== 'ACTIVE' || approver.tenantId !== payer.tenantId || !approverRole
    || !holdsCapability(capabilitiesOf({ role: approverRole, permissions: approver.admin?.permissions }), 'billing.payment.attach')) {
    throw new AppError(403, 'MOVER_FEE_APPROVAL_REQUIRED', 'The independent approver must still hold finance authority.');
  }
  const requested = [...input.sourceSubscriptionIds].sort();
  if (new Set(requested).size !== requested.length || requested.join(',') !== authority.sourceSubscriptionIds.join(',')
    || !requested.includes(input.canonicalSubscriptionId)) throw ownershipError();
  const sources = await tx.subscription.findMany({ where: { id: { in: requested } }, orderBy: { id: 'asc' } });
  const canonical = sources.find((s) => s.id === input.canonicalSubscriptionId)!;
  const empty = compatibleEmptyTrials(sources) && !await hasFinancialHistory(tx, sources);
  const blocker = empty ? null : await paidMoverResolutionBlocker(tx, sources, canonical);
  if (blocker) throw new AppError(409, 'MOVER_FEE_FINANCE_ACTION_REQUIRED', 'These sources still need an existing finance reconciliation or money command.', { reason: blocker });
  const tariff = await moverFeeTariffSubject(tx, authority);
  const tiers = await subscriptionTiersIn(tx, tariff.countryCode);
  const target = partnerRateFor(tiers, tariff.subject);
  const previousRate = Number(canonical.weeklyRate);
  if (previousRate !== target.rate) {
    await tx.subscription.update({ where: { id: canonical.id }, data: { weeklyRate: target.rate } });
    const sequence = await tx.billingEvent.count({ where: { subscriptionId: canonical.id, type: 'TIER_CHANGE' } }) + 1;
    await tx.billingEvent.create({ data: { subscriptionId: canonical.id, type: 'TIER_CHANGE', amount: target.rate, currencyCode: canonical.currencyCode,
      idempotencyKey: `tier:${canonical.id}:${sequence}:${previousRate}->${target.rate}`,
      note: `Finance authority resolution changes the future weekly rate from ${previousRate} to ${target.rate}; issued charges and paid periods retained.` } });
  }
  const aliasEvidence: Record<string, string> = {};
  const sourceEvidence: Record<string, string> = {};
  for (const source of sources) {
    sourceEvidence[source.id] = await moverSourceFinancialFingerprint(tx, source);
    if (source.id !== canonical.id) aliasEvidence[source.id] = sourceEvidence[source.id]!;
  }
  return persistDecision(tx, { ...authority, canonicalSubscriptionId: canonical.id, state: 'ACTIVE', holdReason: null },
    'MOVER_FEE_RESOLVED', input.actorUserId,
    { aliasEvidence, sourceEvidence, previousRevision: authority.revision, approvalId: input.approvalId,
      futureRate: { before: previousRate, after: target.rate }, disposition: empty ? 'EMPTY_COMPATIBLE' : 'PAID_HISTORY_RETAINED' });
}
