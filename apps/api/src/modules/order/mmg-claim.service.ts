import type { Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { ATTESTABLE_PAYMENT_STATUSES, normaliseMmgReference } from '../vendor/mmg-attestation';
import { CHECKOUT_OUTBOX_VERSION, checkoutOutboxId } from './checkout-outbox';
import { MOVER_HOLDING_STATUSES, TERMINAL_ORDER_STATUSES } from './order-status';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import type { AuditFacts } from '../../lib/audit-writer';

// ---------------------------------------------------------------------------
// [ORDER-SPINE S1-6 · REPORT-211] THE DIRECT-MMG CLAIM AUTHORITY.
//
// A direct-MMG marketplace order is paid customer → store OUTSIDE Swift. Swift
// never holds the money and has no provider evidence on this rail, so the only
// signals are two people's words: the store's "it arrived" (CLAIMED) and the
// customer's "I paid" / "I did not pay". This module is the ONE place those
// words are recorded and compared, under the SAME `orders` row lock every
// fulfilment writer already takes.
//
// What it replaced:
//   - a customer denial recorded before the store's claim cleared two fields and
//     persisted nothing, so the store's later claim finished CLAIMED with no
//     dispute and the order moved;
//   - the customer route read a preview outside any lock, so a concurrent store
//     claim could slip between its read and its write with the same result;
//   - the admin resolver cleared whatever dispute was open with an unlocked,
//     unversioned update, then wrote its audit row separately.
//
// The rules, all taken on the LOCKED row:
//   - the customer's statement is durable (`customerMmgClaim`), whichever
//     party speaks first;
//   - two claims that disagree — a denial against a store claim or provider
//     capture, or two different payment references — latch
//     `mmgClaimMismatchAt`, the field every fulfilment gate already reads;
//   - neither party clears a latched disagreement; only an operator decision
//     does, and it must name the generation (`mmgClaimRevision`) it reviewed;
//   - state, evidence and the durable notice obligation commit together or not
//     at all; exact repeats change nothing and announce nothing.
// The migration's CHECK constraints make an unheld disagreement unwritable by
// any writer, this module included.
//
// No provider is imported and no money moves here: this module never writes
// CAPTURED, creates no payment, refund, wallet or settlement row, and never
// treats a customer statement as authority to fulfil.
// ---------------------------------------------------------------------------

export type CustomerMmgClaimValue = 'UNRECORDED' | 'PAID' | 'NOT_PAID';
export type MmgClaimResolutionValue = 'CUSTOMER_PAID' | 'CUSTOMER_DID_NOT_PAY';
export type MmgClaimActor = 'CUSTOMER' | 'STORE' | 'ADMIN';
/** Everyone who takes the order-row lock this authority serializes on: the
 *  three claim actors, and an affirmative shelf-picking write (`PICK`). */
export type MmgClaimLockHolder = MmgClaimActor | 'PICK';
export type MmgDisagreementReason = 'CUSTOMER_DENIED' | 'REFERENCE_MISMATCH';
export type MmgClaimNoticeEffect = 'DISAGREEMENT_OPENED' | 'STORE_CLAIMED' | 'RESOLVED';

/** The claim facts of one order, as read under its row lock. */
export interface MmgClaimFacts {
  id: string;
  tenantId: string;
  orderNumber: string;
  customerId: string;
  vendorId: string | null;
  orderType: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  customerMmgClaim: CustomerMmgClaimValue;
  customerMmgClaimAt: Date | null;
  customerClaimedPaidAt: Date | null;
  customerPaymentRef: string | null;
  mmgAttestedRef: string | null;
  mmgClaimMismatchAt: Date | null;
  mmgClaimRevision: number;
  mmgClaimResolution: MmgClaimResolutionValue | null;
  mmgClaimResolvedAt: Date | null;
  mmgClaimResolvedRevision: number | null;
}

export const MMG_CLAIM_FACTS_SELECT = {
  id: true, tenantId: true, orderNumber: true, customerId: true, vendorId: true, orderType: true,
  status: true, paymentMethod: true, paymentStatus: true,
  customerMmgClaim: true, customerMmgClaimAt: true, customerClaimedPaidAt: true, customerPaymentRef: true,
  mmgAttestedRef: true, mmgClaimMismatchAt: true, mmgClaimRevision: true,
  mmgClaimResolution: true, mmgClaimResolvedAt: true, mmgClaimResolvedRevision: true,
} as const satisfies Prisma.OrderSelect;

/** No claim may change closed history (the ONE terminal set, order-status.ts).
 *  A post-completion dispute belongs to support. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set<string>(TERMINAL_ORDER_STATUSES);
/** The goods have left the store (the ONE custody law, order-status.ts): a
 *  not-paid decision then needs the recovery workflow, not a claim decision. */
const POST_CUSTODY_STATUSES: ReadonlySet<string> = new Set<string>(MOVER_HOLDING_STATUSES);
/** Payment states a customer statement may be recorded against. Reversed,
 *  failed and unresolved payments are not re-opened through a statement. */
const CUSTOMER_CLAIMABLE_PAYMENTS: ReadonlySet<string> = new Set(['PENDING', 'AUTHORIZED', 'CLAIMED', 'CAPTURED']);
/** The store's claim, or a provider capture: someone says the money arrived. */
const STORE_SAYS_PAID: ReadonlySet<string> = new Set(['CLAIMED', 'CAPTURED']);
const ATTEMPT_OPEN: ReadonlySet<string> = new Set<string>(ATTESTABLE_PAYMENT_STATUSES);

// ─── Predicates ─────────────────────────────────────────────────────────────

/** Do the two claims contradict each other? Silence never contradicts. */
export function claimsDisagree(f: Pick<MmgClaimFacts, 'paymentStatus' | 'customerMmgClaim' | 'customerPaymentRef' | 'mmgAttestedRef'>): boolean {
  return disagreementReason(f) !== null;
}

function disagreementReason(f: Pick<MmgClaimFacts, 'paymentStatus' | 'customerMmgClaim' | 'customerPaymentRef' | 'mmgAttestedRef'>): MmgDisagreementReason | null {
  if (!STORE_SAYS_PAID.has(f.paymentStatus)) return null;
  if (f.customerMmgClaim === 'NOT_PAID') return 'CUSTOMER_DENIED';
  if (f.customerMmgClaim === 'PAID' && f.customerPaymentRef != null && f.mmgAttestedRef != null && f.customerPaymentRef !== f.mmgAttestedRef) {
    return 'REFERENCE_MISMATCH';
  }
  return null;
}

/** An operator upheld the store's claim, and nothing has changed since. */
export function adjudicationCoversCurrentFacts(f: Pick<MmgClaimFacts, 'mmgClaimResolution' | 'mmgClaimResolvedRevision' | 'mmgClaimRevision'>): boolean {
  return f.mmgClaimResolution === 'CUSTOMER_PAID' && f.mmgClaimResolvedRevision === f.mmgClaimRevision;
}

/** The TypeScript mirror of `chk_orders_mmg_disagreement_held`. */
export function violatesDisagreementHold(f: MmgClaimFacts): boolean {
  return claimsDisagree(f) && f.mmgClaimMismatchAt == null && !adjudicationCoversCurrentFacts(f);
}

/** A store claim an operator rejected: payment back to pending, the store's
 *  reference kept and reserved. No path but a CUSTOMER_DID_NOT_PAY decision
 *  moves an attested order back to an attestable payment state. */
export function isRejectedMmgAttempt(f: Pick<MmgClaimFacts, 'paymentMethod' | 'paymentStatus' | 'mmgAttestedRef'>): boolean {
  return f.paymentMethod === 'MOBILE_MONEY' && ATTEMPT_OPEN.has(f.paymentStatus) && f.mmgAttestedRef != null;
}

/**
 * [cross-lane gate · invariant 8] Worker/board visibility for rider work: an
 * MMG marketplace order is offered or listed only once someone says the money
 * arrived AND no disagreement is open — the same predicate the locked
 * assignment writes enforce through `assertMmgFulfilmentAllowed`. A missing
 * projection fails closed, exactly as that gate does.
 */
export function mmgDispatchBlocked(order: { paymentMethod: string | null; orderType: string | null; paymentStatus: string; mmgClaimMismatchAt: Date | null }): boolean {
  if (order.paymentMethod !== 'MOBILE_MONEY' || order.orderType === 'TAXI') return false;
  if (order.mmgClaimMismatchAt === undefined) {
    throw new Error('mmgDispatchBlocked: mmgClaimMismatchAt was not projected — the dispute gate cannot be evaluated');
  }
  return order.mmgClaimMismatchAt !== null || !STORE_SAYS_PAID.has(order.paymentStatus);
}

/** The same predicate as a query filter, for boards that list open work. */
export function mmgDispatchEligibleWhere(): Prisma.OrderWhereInput {
  return {
    OR: [
      { paymentMethod: { not: 'MOBILE_MONEY' } },
      { orderType: 'TAXI' },
      { paymentStatus: { in: ['CLAIMED', 'CAPTURED'] }, mmgClaimMismatchAt: null },
    ],
  };
}

function assertMarketplaceMmg(f: Pick<MmgClaimFacts, 'paymentMethod' | 'orderType' | 'vendorId'>): void {
  if (f.paymentMethod !== 'MOBILE_MONEY') {
    throw new AppError(409, 'NOT_A_WALLET_ORDER', 'Only an MMG order carries a payment claim');
  }
  if (f.orderType === 'TAXI' || !f.vendorId) {
    throw new AppError(409, 'NOT_A_MARKETPLACE_ORDER', 'Only an MMG order paid to a store carries a payment claim');
  }
}

function orderClosed(): AppError {
  return new AppError(409, 'ORDER_CLOSED', 'This order is closed — its payment claims can no longer change. Contact support about a closed order.');
}

// ─── Decisions (pure) ───────────────────────────────────────────────────────

export type CustomerClaimDecision =
  | { kind: 'UNCHANGED' }
  | { kind: 'RECORD'; data: Prisma.OrderUncheckedUpdateManyInput; next: MmgClaimFacts; opened: boolean; reason: MmgDisagreementReason | null };

/** The customer's statement. A statement never authorises fulfilment and never
 *  touches the payment state; a denial against a store claim holds the order. */
export function decideCustomerMmgClaim(
  f: MmgClaimFacts,
  input: { paid: boolean; reference?: string | null },
  now: Date,
): CustomerClaimDecision {
  assertMarketplaceMmg(f);
  if (CLOSED_STATUSES.has(f.status)) throw orderClosed();
  if (!CUSTOMER_CLAIMABLE_PAYMENTS.has(f.paymentStatus)) {
    throw new AppError(409, 'PAYMENT_NOT_CLAIMABLE', `This MMG payment is ${f.paymentStatus.toLowerCase()} — contact support rather than recording a claim against it.`);
  }
  const claim: CustomerMmgClaimValue = input.paid ? 'PAID' : 'NOT_PAID';
  // The customer's reference is held to the store's own validator, so the two
  // can be compared; a denial carries none.
  const reference = input.paid && input.reference != null ? normaliseMmgReference(input.reference) : null;
  if (f.customerMmgClaim === claim && f.customerPaymentRef === reference) return { kind: 'UNCHANGED' };

  const revision = f.mmgClaimRevision + 1;
  const next: MmgClaimFacts = {
    ...f,
    customerMmgClaim: claim,
    customerMmgClaimAt: now,
    customerPaymentRef: reference,
    customerClaimedPaidAt: input.paid ? now : null,
    mmgClaimRevision: revision,
  };
  // A latched disagreement stays latched: a changed statement is recorded as
  // new evidence, and only an operator clears the hold.
  const opened = f.mmgClaimMismatchAt == null && claimsDisagree(next);
  if (opened) next.mmgClaimMismatchAt = now;
  const data: Prisma.OrderUncheckedUpdateManyInput = {
    customerMmgClaim: claim,
    customerMmgClaimAt: now,
    customerPaymentRef: reference,
    customerClaimedPaidAt: input.paid ? now : null,
    mmgClaimRevision: revision,
    ...(opened ? { mmgClaimMismatchAt: now } : {}),
  };
  return { kind: 'RECORD', data, next, opened, reason: opened ? disagreementReason(next) : null };
}

export type StoreClaimDecision =
  | { kind: 'ALREADY_CLAIMED' }
  | { kind: 'CLAIM'; data: { mmgClaimRevision: number; mmgClaimMismatchAt?: Date }; opened: boolean; reason: MmgDisagreementReason | null };

/**
 * The store's claim, decided on the LOCKED row before its compare-and-set. The
 * disagreement is part of the SAME statement that writes CLAIMED, so no
 * intermediate row ever violates the hold constraint. `reference` is the
 * already-normalised wallet reference.
 */
export function decideStoreMmgClaim(f: MmgClaimFacts, reference: string, now: Date): StoreClaimDecision {
  // A repeat tap answers with the current row and writes nothing, whatever it carries.
  if (STORE_SAYS_PAID.has(f.paymentStatus)) return { kind: 'ALREADY_CLAIMED' };
  if (isRejectedMmgAttempt(f)) {
    throw new AppError(
      409,
      'MMG_ATTEMPT_REJECTED',
      'Swift support already decided this MMG payment did not reach your wallet. It cannot be marked received again — contact support if the customer has paid since.',
    );
  }
  const revision = f.mmgClaimRevision + 1;
  const after = { ...f, paymentStatus: 'CLAIMED', mmgAttestedRef: reference, mmgClaimRevision: revision };
  const opened = f.mmgClaimMismatchAt == null && claimsDisagree(after);
  return {
    kind: 'CLAIM',
    data: opened ? { mmgClaimRevision: revision, mmgClaimMismatchAt: now } : { mmgClaimRevision: revision },
    opened,
    reason: opened ? disagreementReason(after) : null,
  };
}

export type ResolutionDecision =
  | { kind: 'REPLAY' }
  | { kind: 'RESOLVE'; data: Prisma.OrderUncheckedUpdateManyInput; next: MmgClaimFacts };

/**
 * An operator's decision, bound to the generation they reviewed. The same
 * decision retried is a replay; a different one against a generation already
 * decided, a stale generation, or a case that is not open, is refused.
 */
export function decideMmgClaimResolution(
  f: MmgClaimFacts,
  input: { resolution: MmgClaimResolutionValue; expectedClaimRevision: number },
  now: Date,
): ResolutionDecision {
  assertMarketplaceMmg(f);
  if (f.mmgClaimResolution != null && f.mmgClaimResolvedRevision === input.expectedClaimRevision + 1) {
    if (f.mmgClaimResolution === input.resolution) return { kind: 'REPLAY' };
    throw new AppError(409, 'MMG_CLAIM_ALREADY_RESOLVED', 'A different decision was already recorded for this dispute. Refresh and review the current state.', {
      resolution: f.mmgClaimResolution,
      currentRevision: f.mmgClaimRevision,
    });
  }
  if (CLOSED_STATUSES.has(f.status)) throw orderClosed();
  if (f.mmgClaimMismatchAt == null) {
    throw new AppError(409, 'MMG_CLAIM_NOT_DISPUTED', 'There is no open payment disagreement on this order.', { currentRevision: f.mmgClaimRevision });
  }
  if (f.mmgClaimRevision !== input.expectedClaimRevision) {
    throw new AppError(409, 'MMG_CLAIM_STALE', 'The payment claims changed since you reviewed them. Refresh and decide on the current evidence.', {
      currentRevision: f.mmgClaimRevision,
    });
  }
  if (input.resolution === 'CUSTOMER_DID_NOT_PAY') {
    if (f.paymentStatus === 'CAPTURED') {
      throw new AppError(409, 'MMG_CAPTURE_NOT_REVERSIBLE', 'A provider capture cannot be reversed by a decision. Reconcile it with the provider.');
    }
    if (f.paymentStatus !== 'CLAIMED') {
      throw new AppError(409, 'MMG_NO_STORE_CLAIM', 'There is no store payment claim on this order to decide.');
    }
    if (POST_CUSTODY_STATUSES.has(f.status)) {
      throw new AppError(409, 'MMG_RECOVERY_REQUIRED', 'The goods have already left the store. An unpaid order after pickup needs the recovery workflow, not a claim decision.');
    }
  } else if (!STORE_SAYS_PAID.has(f.paymentStatus)) {
    throw new AppError(409, 'MMG_NO_STORE_CLAIM', 'There is no store payment claim on this order to uphold.');
  }
  const revision = f.mmgClaimRevision + 1;
  const data: Prisma.OrderUncheckedUpdateManyInput = {
    mmgClaimMismatchAt: null,
    mmgClaimResolution: input.resolution,
    mmgClaimResolvedAt: now,
    mmgClaimRevision: revision,
    mmgClaimResolvedRevision: revision,
    // An upheld claim keeps CLAIMED/CAPTURED; a rejected one returns to PENDING
    // and keeps the store's reference, reserved, so it cannot be revived.
    ...(input.resolution === 'CUSTOMER_DID_NOT_PAY' ? { paymentStatus: 'PENDING' as const } : {}),
  };
  return {
    kind: 'RESOLVE',
    data,
    next: {
      ...f,
      mmgClaimMismatchAt: null,
      mmgClaimResolution: input.resolution,
      mmgClaimResolvedAt: now,
      mmgClaimRevision: revision,
      mmgClaimResolvedRevision: revision,
      paymentStatus: input.resolution === 'CUSTOMER_DID_NOT_PAY' ? 'PENDING' : f.paymentStatus,
    },
  };
}

// ─── The locked commands ────────────────────────────────────────────────────

/** The transaction surface these commands need — a real `Prisma.TransactionClient`
 *  in the routes, an in-memory double in the service-free suite. */
export type MmgClaimTx = Pick<Prisma.TransactionClient, '$queryRaw'> & {
  order: Pick<Prisma.TransactionClient['order'], 'findUnique' | 'updateMany'>;
  auditLog: Pick<Prisma.TransactionClient['auditLog'], 'create'>;
  orderOutbox: Pick<Prisma.TransactionClient['orderOutbox'], 'createMany'>;
};

/** Test-only seams, never set by a route: `afterLock` runs once the row lock is
 *  held and the fresh read is done (the real-PostgreSQL race barriers pause
 *  here); `beforeCommit` runs after every write is staged (fault injection
 *  proves the whole transaction rolls back). */
export const mmgClaimLockObserver: {
  afterLock?: (ctx: { orderId: string; actor: MmgClaimLockHolder }) => Promise<void>;
  beforeCommit?: (ctx: { orderId: string; actor: MmgClaimLockHolder }) => Promise<void>;
} = {};

async function readLockedFacts(tx: MmgClaimTx, orderId: string): Promise<MmgClaimFacts> {
  const row = await tx.order.findUnique({ where: { id: orderId }, select: MMG_CLAIM_FACTS_SELECT });
  if (!row) throw new NotFoundError('Order', orderId);
  return row as MmgClaimFacts;
}

export interface MmgClaimNotice {
  orderId: string;
  tenantId: string;
  /** The generation this obligation announces. */
  revision: number;
  effect: MmgClaimNoticeEffect;
  openedBy: 'CUSTOMER' | 'STORE' | null;
  reason: MmgDisagreementReason | null;
  resolution: MmgClaimResolutionValue | null;
}

export interface MmgClaimCommandOutcome {
  /** True when the command changed nothing (an exact repeat or a replayed decision). */
  replayed: boolean;
  facts: MmgClaimFacts;
  /** The durable obligation this command committed, if any. */
  notice: MmgClaimNotice | null;
  outboxId: string | null;
}

export const MMG_CLAIM_NOTICE_KIND = 'mmg-claim-notice' as const;

/** One obligation per claim generation, ever. */
export function mmgClaimNoticeDedupeKey(orderId: string, revision: number): string {
  return `order:${orderId}:mmg-claim:r${revision}`;
}

/** The notice obligation, written INSIDE the claim transaction: it commits
 *  with the state it announces, or not at all. */
export async function persistMmgClaimNoticeInTransaction(tx: MmgClaimTx, notice: MmgClaimNotice, now: Date): Promise<{ id: string; dedupeKey: string }> {
  const dedupeKey = mmgClaimNoticeDedupeKey(notice.orderId, notice.revision);
  const id = checkoutOutboxId(dedupeKey);
  await tx.orderOutbox.createMany({
    data: [{
      id,
      tenantId: notice.tenantId,
      dedupeKey,
      orderId: notice.orderId,
      kind: MMG_CLAIM_NOTICE_KIND,
      queue: 'notification',
      payload: { version: CHECKOUT_OUTBOX_VERSION, ...notice } as Prisma.InputJsonValue,
      delayMs: 0,
      availableAt: now,
    }],
    skipDuplicates: true,
  });
  return { id, dedupeKey };
}

/**
 * The customer's statement. Locks the row with the customer AND tenant
 * predicates before reading it, so a foreign order is simply not found and a
 * concurrent store claim or decision waits for this one (or this for it).
 */
export async function recordCustomerMmgClaim(
  tx: MmgClaimTx,
  input: { orderId: string; customerId: string; tenantId: string | null; paid: boolean; reference?: string | null; now?: Date },
): Promise<MmgClaimCommandOutcome & { opened: boolean }> {
  const now = input.now ?? new Date();
  const locked = input.tenantId
    ? await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "orders" WHERE "id" = ${input.orderId} AND "customerId" = ${input.customerId} AND "tenantId" = ${input.tenantId} FOR UPDATE`
    : await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "orders" WHERE "id" = ${input.orderId} AND "customerId" = ${input.customerId} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError('Order', input.orderId);
  const facts = await readLockedFacts(tx, input.orderId);
  await mmgClaimLockObserver.afterLock?.({ orderId: input.orderId, actor: 'CUSTOMER' });

  const decision = decideCustomerMmgClaim(facts, { paid: input.paid, reference: input.reference ?? null }, now);
  if (decision.kind === 'UNCHANGED') return { replayed: true, opened: false, facts, notice: null, outboxId: null };

  const cas = await tx.order.updateMany({ where: { id: facts.id, mmgClaimRevision: facts.mmgClaimRevision }, data: decision.data });
  if (cas.count !== 1) {
    throw new AppError(409, 'MMG_CLAIM_CONFLICT', 'The payment claims changed while this was being recorded. Refresh and try again.');
  }
  await tx.auditLog.create({
    data: {
      userId: input.customerId,
      action: input.paid ? 'CUSTOMER_CLAIMED_PAID' : 'CUSTOMER_CLAIMED_NOT_PAID',
      entity: 'Order',
      entityId: facts.id,
      changes: {
        claim: input.paid ? 'customer_claimed_paid' : 'customer_claimed_not_paid',
        reference: decision.next.customerPaymentRef,
        previousClaim: facts.customerMmgClaim,
        storeStatus: facts.paymentStatus,
        claimRevision: decision.next.mmgClaimRevision,
      },
    },
  });
  let notice: MmgClaimNotice | null = null;
  let outboxId: string | null = null;
  if (decision.opened) {
    await tx.auditLog.create({
      data: {
        userId: input.customerId,
        action: 'MMG_CLAIM_MISMATCH',
        entity: 'Order',
        entityId: facts.id,
        changes: { openedBy: 'CUSTOMER', reason: decision.reason, storeStatus: facts.paymentStatus, claimRevision: decision.next.mmgClaimRevision },
      },
    });
    notice = {
      orderId: facts.id, tenantId: facts.tenantId, revision: decision.next.mmgClaimRevision,
      effect: 'DISAGREEMENT_OPENED', openedBy: 'CUSTOMER', reason: decision.reason, resolution: null,
    };
    outboxId = (await persistMmgClaimNoticeInTransaction(tx, notice, now)).id;
  }
  await mmgClaimLockObserver.beforeCommit?.({ orderId: input.orderId, actor: 'CUSTOMER' });
  return { replayed: false, opened: decision.opened, facts: decision.next, notice, outboxId };
}

/**
 * The store claim's own evidence and obligation, staged inside the vendor
 * route's claim transaction AFTER its compare-and-set and attestation. `facts`
 * is the fresh row as that transaction leaves it.
 */
export async function stageStoreMmgClaim(
  tx: MmgClaimTx,
  input: { facts: MmgClaimFacts; decision: Extract<StoreClaimDecision, { kind: 'CLAIM' }>; actorId: string; reference: string; now: Date },
): Promise<{ notice: MmgClaimNotice; outboxId: string }> {
  const { facts, decision } = input;
  if (decision.opened) {
    await tx.auditLog.create({
      data: {
        userId: input.actorId,
        action: 'MMG_CLAIM_MISMATCH',
        entity: 'Order',
        entityId: facts.id,
        changes: { openedBy: 'STORE', reason: decision.reason, reference: input.reference, claimRevision: facts.mmgClaimRevision },
      },
    });
  }
  const notice: MmgClaimNotice = {
    orderId: facts.id,
    tenantId: facts.tenantId,
    revision: facts.mmgClaimRevision,
    effect: decision.opened ? 'DISAGREEMENT_OPENED' : 'STORE_CLAIMED',
    openedBy: decision.opened ? 'STORE' : null,
    reason: decision.reason,
    resolution: null,
  };
  const { id } = await persistMmgClaimNoticeInTransaction(tx, notice, input.now);
  await mmgClaimLockObserver.beforeCommit?.({ orderId: facts.id, actor: 'STORE' });
  return { notice, outboxId: id };
}

/**
 * An operator's decision: locked with the operator's tenant, bound to the
 * reviewed generation, and committed with its audit row and its notice
 * obligation — the `audit` callback is the route's `auditWithin`, invoked as
 * the last write inside this transaction.
 */
export async function resolveMmgClaimDisagreement(
  tx: MmgClaimTx,
  input: {
    orderId: string;
    tenantId: string;
    resolution: MmgClaimResolutionValue;
    expectedClaimRevision: number;
    note: string;
    actorId: string;
    now?: Date;
    audit: (tx: MmgClaimTx, facts: AuditFacts) => Promise<void>;
  },
): Promise<MmgClaimCommandOutcome> {
  const now = input.now ?? new Date();
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "orders" WHERE "id" = ${input.orderId} AND "tenantId" = ${input.tenantId} FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError('Order', input.orderId);
  const facts = await readLockedFacts(tx, input.orderId);
  await mmgClaimLockObserver.afterLock?.({ orderId: input.orderId, actor: 'ADMIN' });

  const decision = decideMmgClaimResolution(facts, input, now);
  if (decision.kind === 'REPLAY') return { replayed: true, facts, notice: null, outboxId: null };

  const cas = await tx.order.updateMany({ where: { id: facts.id, mmgClaimRevision: input.expectedClaimRevision }, data: decision.data });
  if (cas.count !== 1) {
    throw new AppError(409, 'MMG_CLAIM_STALE', 'The payment claims changed since you reviewed them. Refresh and decide on the current evidence.', {
      currentRevision: facts.mmgClaimRevision,
    });
  }
  const notice: MmgClaimNotice = {
    orderId: facts.id, tenantId: facts.tenantId, revision: decision.next.mmgClaimRevision,
    effect: 'RESOLVED', openedBy: null, reason: null, resolution: input.resolution,
  };
  const { id } = await persistMmgClaimNoticeInTransaction(tx, notice, now);
  await input.audit(tx, {
    decision: input.resolution,
    expectedClaimRevision: input.expectedClaimRevision,
    claimRevision: decision.next.mmgClaimRevision,
    paymentStatusBefore: facts.paymentStatus,
    paymentStatusAfter: decision.next.paymentStatus,
    note: input.note,
    noticeObligation: id,
  });
  await mmgClaimLockObserver.beforeCommit?.({ orderId: input.orderId, actor: 'ADMIN' });
  return { replayed: false, facts: decision.next, notice, outboxId: id };
}

// ─── Projection ─────────────────────────────────────────────────────────────

export interface MmgClaimView {
  customerClaim: CustomerMmgClaimValue;
  customerClaimAt: string | null;
  storeClaimed: boolean;
  providerCaptured: boolean;
  disputed: boolean;
  disputedAt: string | null;
  resolution: MmgClaimResolutionValue | null;
  resolvedAt: string | null;
  attemptRejected: boolean;
  revision: number;
  canClaim: boolean;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** What each party said, whether the order is held, and whether the customer
 *  may make a statement now. Null for anything that is not a direct-MMG
 *  marketplace order. */
export function mmgClaimView(f: MmgClaimFacts): MmgClaimView | null {
  if (f.paymentMethod !== 'MOBILE_MONEY' || f.orderType === 'TAXI' || !f.vendorId) return null;
  return {
    customerClaim: f.customerMmgClaim,
    customerClaimAt: iso(f.customerMmgClaimAt),
    storeClaimed: f.paymentStatus === 'CLAIMED',
    providerCaptured: f.paymentStatus === 'CAPTURED',
    disputed: f.mmgClaimMismatchAt != null,
    disputedAt: iso(f.mmgClaimMismatchAt),
    resolution: f.mmgClaimResolution,
    resolvedAt: iso(f.mmgClaimResolvedAt),
    attemptRejected: isRejectedMmgAttempt(f),
    revision: f.mmgClaimRevision,
    canClaim: !CLOSED_STATUSES.has(f.status) && CUSTOMER_CLAIMABLE_PAYMENTS.has(f.paymentStatus),
  };
}

// ─── Delivering the obligation ──────────────────────────────────────────────

const NOTICE_EFFECTS: ReadonlySet<string> = new Set(['DISAGREEMENT_OPENED', 'STORE_CLAIMED', 'RESOLVED']);

/** The worker's payload, parsed strictly: a malformed obligation fails closed. */
export function parseMmgClaimNoticePayload(raw: unknown): MmgClaimNotice {
  const p = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  if (!text(p['orderId']) || !text(p['tenantId'])) throw new Error('mmg-claim-notice: orderId and tenantId are required');
  const revision = p['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) throw new Error('mmg-claim-notice: revision must be a positive integer');
  if (typeof p['effect'] !== 'string' || !NOTICE_EFFECTS.has(p['effect'])) throw new Error('mmg-claim-notice: unknown effect');
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : null);
  return {
    orderId: p['orderId'] as string,
    tenantId: p['tenantId'] as string,
    revision,
    effect: p['effect'] as MmgClaimNoticeEffect,
    openedBy: oneOf(p['openedBy'], ['CUSTOMER', 'STORE'] as const),
    reason: oneOf(p['reason'], ['CUSTOMER_DENIED', 'REFERENCE_MISMATCH'] as const),
    resolution: oneOf(p['resolution'], ['CUSTOMER_PAID', 'CUSTOMER_DID_NOT_PAY'] as const),
  };
}

export interface MmgClaimNoticeDeps {
  prisma: {
    order: { findFirst(args: unknown): Promise<unknown> };
    orderOutbox?: { updateMany(args: unknown): Promise<unknown> };
  };
  notifications: {
    send(payload: {
      userId: string; type: 'ORDER_UPDATE' | 'PAYMENT_RECEIVED'; title: string; body: string;
      audience: 'customer' | 'business'; data: Record<string, unknown>; dedupeKey: string;
    }): Promise<string>;
  };
  /** Pages the tenant's operators; returns how many were actually reached. */
  pageAdmins?: (input: { tenantId: string | null; title: string; body: string; data: Record<string, unknown>; dedupeKey: string }) => Promise<number>;
}

export interface MmgClaimDelivery {
  /** Every notice still owed was persisted (and operators were reached, where owed). */
  complete: boolean;
  sent: Array<'customer' | 'business' | 'admin'>;
  skipped: Array<'customer' | 'business' | 'admin'>;
  adminReached: number | null;
}

type OrderForNotice = MmgClaimFacts & { vendor: { owner: { userId: string } | null } | null };

const REASON_TEXT: Record<MmgDisagreementReason, { customer: string; store: string; ops: string }> = {
  CUSTOMER_DENIED: {
    customer: 'you told us you did not pay, but the store reported receiving an MMG payment',
    store: 'the customer says they did not pay, but your store reported the MMG payment received',
    ops: 'the store reported the MMG payment received; the customer says they did not pay',
  },
  REFERENCE_MISMATCH: {
    customer: 'the MMG reference you gave does not match the one the store reported',
    store: 'the MMG reference the customer gave does not match the one your store reported',
    ops: 'the store and the customer gave different MMG payment references',
  },
};

/**
 * Deliver one obligation. Every notice is keyed by (order, generation, role),
 * so a retry — the request's own fast path, the outbox sweep, a replayed job —
 * collapses into the first delivery. Each notice is re-checked against the
 * CURRENT row: a delayed obligation never tells anyone a dispute is open after
 * it was resolved, or that a decision stands after the claims moved on.
 */
export async function deliverMmgClaimNotice(deps: MmgClaimNoticeDeps, notice: MmgClaimNotice): Promise<MmgClaimDelivery> {
  return runWithTenant(notice.tenantId, async () => {
    const order = (await deps.prisma.order.findFirst({
      where: { id: notice.orderId, tenantId: notice.tenantId },
      select: { ...MMG_CLAIM_FACTS_SELECT, vendor: { select: { owner: { select: { userId: true } } } } },
    })) as OrderForNotice | null;
    const sent: MmgClaimDelivery['sent'] = [];
    const skipped: MmgClaimDelivery['skipped'] = [];
    if (!order) return { complete: true, sent, skipped: ['customer', 'business', 'admin'], adminReached: null };

    const businessUserId = order.vendor?.owner?.userId ?? null;
    const key = (role: 'customer' | 'business' | 'admin') => `mmg-claim:${order.id}:r${notice.revision}:${role}`;
    const plan: Array<{ role: 'customer' | 'business'; userId: string; type: 'ORDER_UPDATE' | 'PAYMENT_RECEIVED'; title: string; body: string; data: Record<string, unknown> }> = [];
    let page: { title: string; body: string } | null = null;

    if (notice.effect === 'STORE_CLAIMED') {
      if (STORE_SAYS_PAID.has(order.paymentStatus) && order.mmgClaimMismatchAt == null) {
        plan.push({
          role: 'customer', userId: order.customerId, type: 'PAYMENT_RECEIVED',
          title: 'The store reported your payment',
          body: `The store reported receiving your MMG payment for order #${order.orderNumber}. Swift doesn't hold or check this money — if you didn't pay, tell us from the order screen.`,
          // `mmg_payment_confirmed` is the routing kind the apps already know; the words say what it is.
          data: { orderId: order.id, kind: 'mmg_payment_confirmed', claimRevision: notice.revision },
        });
      } else {
        skipped.push('customer');
      }
    } else if (notice.effect === 'DISAGREEMENT_OPENED') {
      if (order.mmgClaimMismatchAt != null) {
        const why = REASON_TEXT[notice.reason ?? 'CUSTOMER_DENIED'];
        plan.push({
          role: 'customer', userId: order.customerId, type: 'ORDER_UPDATE',
          title: 'We’re checking your payment',
          body: `For order #${order.orderNumber}, ${why.customer}. The order is paused until a person reviews it. Swift never holds this money.`,
          data: { orderId: order.id, kind: 'mmg_claim_disputed', claimRevision: notice.revision },
        });
        if (businessUserId) {
          plan.push({
            role: 'business', userId: businessUserId, type: 'ORDER_UPDATE',
            title: 'Payment disputed — order on hold',
            body: `Order #${order.orderNumber}: ${why.store}. Don't prepare or hand it over until Swift support resolves it.`,
            data: { orderId: order.id, kind: 'mmg_claim_disputed', claimRevision: notice.revision },
          });
        }
        page = {
          title: 'MMG payment claims disagree',
          body: `Order ${order.id} (#${order.orderNumber}): ${why.ops}. Fulfilment is held until someone resolves it.`,
        };
      } else {
        skipped.push('customer', 'business', 'admin');
      }
    } else if (order.mmgClaimRevision === notice.revision && order.mmgClaimResolvedRevision === notice.revision && notice.resolution) {
      const upheld = notice.resolution === 'CUSTOMER_PAID';
      plan.push({
        role: 'customer', userId: order.customerId, type: 'ORDER_UPDATE',
        title: 'Payment review finished',
        body: upheld
          ? `Swift support accepted the store's report that your MMG payment for order #${order.orderNumber} arrived. The order can continue.`
          : `Swift support found that no MMG payment for order #${order.orderNumber} reached the store. It won't be prepared or delivered — you can cancel it from the order screen.`,
        data: { orderId: order.id, kind: 'mmg_claim_resolved', claimRevision: notice.revision },
      });
      if (businessUserId) {
        plan.push({
          role: 'business', userId: businessUserId, type: 'ORDER_UPDATE',
          title: 'Payment review finished',
          body: upheld
            ? `Swift support accepted your payment report for order #${order.orderNumber}. You can continue with the order.`
            : `Swift support decided the MMG payment for order #${order.orderNumber} did not arrive. Don't prepare or hand over this order.`,
          data: { orderId: order.id, kind: 'mmg_claim_resolved', claimRevision: notice.revision },
        });
      }
    } else {
      skipped.push('customer', 'business');
    }

    let complete = true;
    for (const n of plan) {
      const id = await deps.notifications.send({
        userId: n.userId, type: n.type, title: n.title, body: n.body,
        audience: n.role, data: n.data, dedupeKey: key(n.role),
      });
      if (id) sent.push(n.role); else complete = false;
    }
    let adminReached: number | null = null;
    if (page) {
      const pageAdmins = deps.pageAdmins ?? defaultPageAdmins(deps);
      adminReached = await pageAdmins({
        tenantId: order.tenantId,
        title: page.title,
        body: page.body,
        data: { kind: 'mmg_claim_mismatch', orderId: order.id, claimRevision: notice.revision },
        dedupeKey: key('admin'),
      });
      if (adminReached > 0) sent.push('admin'); else complete = false;
    }
    return { complete, sent, skipped, adminReached };
  });
}

function defaultPageAdmins(deps: MmgClaimNoticeDeps): NonNullable<MmgClaimNoticeDeps['pageAdmins']> {
  return async (input) => {
    const { notifyAdmins } = await import('../notification/notification.service');
    return notifyAdmins(deps.prisma as never, deps.notifications as never, input);
  };
}

/** The request's fast path: deliver now, and mark the obligation processed
 *  only when nothing it owes is still outstanding. Anything left stays owed:
 *  the outbox sweep's `drainMmgClaimNotices` runs the same code until it is. */
export async function completeMmgClaimNotice(deps: MmgClaimNoticeDeps, input: { outboxId: string; notice: MmgClaimNotice }): Promise<MmgClaimDelivery> {
  const result = await deliverMmgClaimNotice(deps, input.notice);
  if (result.complete && deps.prisma.orderOutbox) {
    await runWithTenant(input.notice.tenantId, () => deps.prisma.orderOutbox!.updateMany({
      where: { id: input.outboxId, processedAt: null },
      data: { processedAt: new Date(), claimedAt: null },
    }));
  }
  return result;
}

/** Deliver one obligation from its stored payload, parsed strictly. */
export async function runMmgClaimNoticeJob(deps: MmgClaimNoticeDeps, data: unknown): Promise<MmgClaimDelivery> {
  return deliverMmgClaimNotice(deps, parseMmgClaimNoticePayload(data));
}

// ─── The durable drain ──────────────────────────────────────────────────────

const NOTICE_DRAIN_LEASE_MS = 60_000;
const NOTICE_RETRY_BASE_MS = 30_000;
const NOTICE_RETRY_MAX_MS = 15 * 60_000;

/** How long an obligation still owed after `attempts` tries waits before the
 *  next: 30 s, doubling, never more than 15 minutes apart. */
export function mmgClaimNoticeRetryDelayMs(attempts: number): number {
  return Math.min(NOTICE_RETRY_MAX_MS, NOTICE_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempts - 1), 10));
}

export interface MmgClaimNoticeDrainDeps extends Omit<MmgClaimNoticeDeps, 'prisma'> {
  prisma: {
    order: MmgClaimNoticeDeps['prisma']['order'];
    orderOutbox: {
      findFirst(args: unknown): Promise<unknown>;
      updateMany(args: unknown): Promise<{ count: number }>;
    };
  };
  now?: () => Date;
}

/**
 * [ORDER-SPINE S1-6 · R2] The outbox sweep's own drain of claim notices.
 *
 * A claim notice is owed until every recipient it names holds a durable inbox
 * row and, for a dispute, an operator was reached. Handing it to a queue
 * cannot keep that promise: the generic publisher consumes a row the moment
 * the queue accepts the job, and nothing the worker then fails to deliver
 * brings it back. So the publisher never claims this kind
 * (`IN_PROCESS_OUTBOX_KINDS`), and the sweep delivers it here instead.
 *
 * Each obligation is leased by compare-and-set on its attempt counter (two
 * sweeps never hold one; a crashed drain's lease lapses), delivered with the
 * per-(order, generation, role) dedupe keys, and consumed only when that
 * delivery was complete — or the current row made it moot. Anything still
 * owed is released with its reason and backed off for the next sweep.
 */
export async function drainMmgClaimNotices(
  deps: MmgClaimNoticeDrainDeps,
  options: { limit?: number; leaseMs?: number } = {},
): Promise<{ delivered: number; owed: number; failed: number }> {
  const limit = Math.max(1, options.limit ?? 50);
  const leaseMs = Math.max(1_000, options.leaseMs ?? NOTICE_DRAIN_LEASE_MS);
  const outbox = deps.prisma.orderOutbox;
  const clock = () => deps.now?.() ?? new Date();
  const system = <T>(fn: () => Promise<T>) => runAsSystem('mmg-claim-notice-drain', fn);
  let delivered = 0;
  let owed = 0;
  let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const now = clock();
    const due = {
      kind: MMG_CLAIM_NOTICE_KIND,
      processedAt: null,
      availableAt: { lte: now },
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - leaseMs) } }],
    };
    const row = (await system(() => outbox.findFirst({
      where: due,
      orderBy: { createdAt: 'asc' },
      select: { id: true, payload: true, attempts: true },
    }))) as { id: string; payload: unknown; attempts: number } | null;
    if (!row) break;
    const lease = await system(() => outbox.updateMany({
      where: { ...due, id: row.id, attempts: row.attempts },
      data: { claimedAt: now, attempts: { increment: 1 } },
    }));
    if (lease.count !== 1) continue; // another sweep took it first
    const attempts = row.attempts + 1;
    const settle = (data: Record<string, unknown>) =>
      system(() => outbox.updateMany({ where: { id: row.id, processedAt: null, attempts }, data }));
    const retryLater = (lastError: string) =>
      settle({ claimedAt: null, lastError: lastError.slice(0, 2_000), availableAt: new Date(clock().getTime() + mmgClaimNoticeRetryDelayMs(attempts)) });
    try {
      const result = await deliverMmgClaimNotice(deps, parseMmgClaimNoticePayload(row.payload));
      if (result.complete) {
        await settle({ processedAt: clock(), claimedAt: null, lastError: null });
        delivered += 1;
      } else {
        await retryLater(`incomplete: sent ${result.sent.join(',') || 'none'}; operators reached ${result.adminReached ?? 'n/a'}`);
        owed += 1;
      }
    } catch (err) {
      failed += 1;
      await retryLater(`failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    }
  }
  return { delivered, owed, failed };
}
