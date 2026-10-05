import type { CustodyIncidentReason, CustodyRecoveryCase, CustodyRecoveryState, OrderStatus, Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { riderFloatForOrder } from '../dispatch/float.service';
import {
  CUSTODY_CASE_LAW,
  RIDER_IN_CUSTODY_STATUSES,
  isCustodyCaseOpen,
  isCustodyCaseTransition,
  isMoverHolding,
  isTerminalOrderStatus,
} from '../order/order-status';

// ---------------------------------------------------------------------------
// [AF-MOB-006 · S0] THE CUSTODY RECOVERY CASE — the core.
//
// After pickup a rider holds someone else's goods and, on cash, has fronted the
// store. When that delivery cannot be finished, the platform's answer was a
// 409 that said "Call support": nobody owned the problem, nothing timed it,
// and nothing recorded how it ended. A case is that record: ONE open case per
// order, an operations owner, a deadline that pages humans, and a resolution.
//
// This file is the light half, imported by the canonical order seam, the
// delivery watchdog and session revocation. It touches canonical rows only and
// never publishes; callers own every post-commit effect. The route-level
// operations (the verified transfer, relay assignment, escalation sweep) are in
// custody-recovery.ts. The states and their edges are in order/order-status.ts.
//
// The trail is audit_logs (append-only and hash-chained in the database): every
// open, state change, owner, relay, failed code, verified transfer and
// escalation writes one row with entity 'CustodyRecoveryCase'.
// ---------------------------------------------------------------------------

/** The audit entity every case row is recorded under. */
export const CUSTODY_CASE_ENTITY = 'CustodyRecoveryCase';

/** Who acted on a case. The trail records it beside the user id. */
export type CaseActorRole = 'RIDER' | 'RELAY_RIDER' | 'ADMIN' | 'VENDOR' | 'SYSTEM' | 'ORDER_TRANSITION';

export interface CaseActor {
  /** A user id, or null for the system. */
  userId: string | null;
  role: CaseActorRole;
}

/**
 * How long an open state may sit before humans are paged (minutes): 10 for a
 * hold, 15 to name a relay rider, 30 for the handoff, 60 for a return (owner
 * ruling, 4 Oct 2026). A resolved state has no deadline.
 */
export const CUSTODY_CASE_DEADLINE_MINUTES: Record<CustodyRecoveryState, number | null> = {
  SUPPORT_HOLD: 10,
  RETURN_REQUIRED: 60,
  RELAY_REQUIRED: 15,
  TRANSFER_IN_PROGRESS: 30,
  DELIVERED: null,
  RETURNED: null,
  TRANSFERRED: null,
  CLOSED: null,
};

/** The deadline an OPEN state starts with. */
export function caseDeadline(state: CustodyRecoveryState, now: Date): Date {
  const minutes = CUSTODY_CASE_DEADLINE_MINUTES[state] ?? 0;
  return new Date(now.getTime() + minutes * 60_000);
}

/** The reasons a rider may report. The system reasons are recorded by the
 *  watchdog, session revocation and the return path, never chosen by a person. */
export const RIDER_INCIDENT_REASONS = [
  'VEHICLE_BREAKDOWN', 'CRASH', 'MEDICAL', 'UNSAFE_RECIPIENT', 'RECIPIENT_ABSENT',
  'INACCESSIBLE_PROPERTY', 'DAMAGED_OR_PROHIBITED', 'WRONG_PACKAGE', 'POLICE_OR_ROAD_CLOSURE',
  'DEVICE_FAILURE', 'OTHER',
] as const satisfies readonly CustodyIncidentReason[];

/** Write one trail row, inside the caller's transaction. */
export async function recordCaseEvent(
  tx: Prisma.TransactionClient,
  kase: Pick<CustodyRecoveryCase, 'id' | 'orderId'>,
  action: string,
  actor: CaseActor,
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: actor.userId,
      action: `CUSTODY_CASE_${action}`,
      entity: CUSTODY_CASE_ENTITY,
      entityId: kase.id,
      changes: { orderId: kase.orderId, actorRole: actor.role, ...details } as Prisma.InputJsonValue,
    },
  });
}

/** Lock and read the order's OPEN case, if any. The caller must already hold
 *  the order row lock (order before case, everywhere). */
export async function lockOpenCase(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<CustodyRecoveryCase | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "custody_recovery_cases"
    WHERE "orderId" = ${orderId} AND "resolvedAt" IS NULL
    FOR UPDATE`;
  if (rows.length === 0) return null;
  return tx.custodyRecoveryCase.findUnique({ where: { id: rows[0]!.id } });
}

/** Lock and read one case by id. The caller must already hold its order lock. */
export async function lockCase(
  tx: Prisma.TransactionClient,
  caseId: string,
): Promise<CustodyRecoveryCase | null> {
  await tx.$queryRaw`SELECT "id" FROM "custody_recovery_cases" WHERE "id" = ${caseId} FOR UPDATE`;
  return tx.custodyRecoveryCase.findUnique({ where: { id: caseId } });
}

export interface OpenCaseInput {
  order: { id: string; riderId: string | null; status: OrderStatus; orderType: string | null };
  reason: CustodyIncidentReason;
  note?: string | null;
  actor: CaseActor;
  gps?: { lat: number; lng: number } | null;
  /** RETURN_REQUIRED when the case is born from a started return. */
  state?: 'SUPPORT_HOLD' | 'RETURN_REQUIRED';
  now?: Date;
}

/**
 * Open the order's recovery case, or return the one already open — one owned
 * case per incident, never two. Inside the caller's transaction, which must
 * hold the order row lock. Refuses an order whose goods are not in a rider's
 * custody: before pickup the handback releases the order; after the order is
 * over there is nothing to recover.
 */
export async function openCaseInTransaction(
  tx: Prisma.TransactionClient,
  input: OpenCaseInput,
): Promise<{ kase: CustodyRecoveryCase; created: boolean }> {
  const { order } = input;
  if (!order.riderId || order.orderType === 'TAXI' || !RIDER_IN_CUSTODY_STATUSES.includes(order.status)) {
    throw new AppError(409, 'NOT_IN_CUSTODY',
      'A recovery case is only for goods a rider has already picked up.');
  }
  const existing = await lockOpenCase(tx, order.id);
  if (existing) return { kase: existing, created: false };

  const now = input.now ?? new Date();
  const state = input.state ?? 'SUPPORT_HOLD';
  const kase = await tx.custodyRecoveryCase.create({
    data: {
      orderId: order.id,
      state,
      reason: input.reason,
      reasonNote: input.note ?? null,
      openedBy: input.actor.userId,
      holderRiderId: order.riderId,
      deadlineAt: caseDeadline(state, now),
      incidentLat: input.gps?.lat ?? null,
      incidentLng: input.gps?.lng ?? null,
    },
  });
  await recordCaseEvent(tx, kase, 'OPENED', input.actor, {
    state, reason: input.reason, note: input.note ?? null, orderStatus: order.status,
    holderRiderId: order.riderId, gps: input.gps ?? null,
  });
  return { kase, created: true };
}

export interface MoveCaseOptions {
  /** Extra columns that change with this step (relay rider, code, holder). */
  data?: Prisma.CustodyRecoveryCaseUncheckedUpdateInput;
  details?: Record<string, unknown>;
  resolution?: string;
  now?: Date;
}

/**
 * Move a LOCKED case along a declared edge. Every step bumps the version,
 * re-arms the deadline for an open state (or stamps resolvedAt for a resolved
 * one) and writes a trail row. Leaving TRANSFER_IN_PROGRESS any way but the
 * verified transfer voids the code, so a code shown once can never move
 * custody later.
 */
export async function moveCaseInTransaction(
  tx: Prisma.TransactionClient,
  kase: CustodyRecoveryCase,
  to: CustodyRecoveryState,
  actor: CaseActor,
  opts: MoveCaseOptions = {},
): Promise<CustodyRecoveryCase> {
  if (!isCustodyCaseTransition(kase.state, to)) {
    throw new AppError(409, 'RECOVERY_STEP_NOT_ALLOWED',
      `This recovery case is ${kase.state.toLowerCase().replace(/_/g, ' ')} and cannot move to ${to.toLowerCase().replace(/_/g, ' ')}.`,
      { from: kase.state, to });
  }
  const now = opts.now ?? new Date();
  const open = isCustodyCaseOpen(to);
  const leavingTransfer = kase.state === 'TRANSFER_IN_PROGRESS' && to !== 'TRANSFER_IN_PROGRESS';
  const data: Prisma.CustodyRecoveryCaseUncheckedUpdateInput = {
    state: to,
    version: { increment: 1 },
    ...(open ? { deadlineAt: caseDeadline(to, now), resolvedAt: null } : { resolvedAt: now, resolution: opts.resolution ?? to }),
    ...(leavingTransfer ? { transferCode: null, transferCodeExpiresAt: null, transferAttempts: 0 } : {}),
    // A relay that did not happen leaves no relay rider behind: the task
    // disappears from their list the moment the step commits.
    ...(leavingTransfer && to !== 'TRANSFERRED' ? { relayRiderId: null } : {}),
    ...(opts.data ?? {}),
  };
  const moved = await tx.custodyRecoveryCase.updateMany({
    where: { id: kase.id, version: kase.version },
    data,
  });
  if (moved.count !== 1) {
    throw new AppError(409, 'RECOVERY_STALE', 'This recovery case changed while the action was in progress — refresh and try again.');
  }
  await recordCaseEvent(tx, kase, 'STATE_CHANGED', actor, {
    from: kase.state, to, version: kase.version + 1, ...(opts.details ?? {}),
  });
  return tx.custodyRecoveryCase.findUniqueOrThrow({ where: { id: kase.id } });
}

/** The case state an order's terminal status settles an open case to. */
function resolvedStateFor(target: OrderStatus): CustodyRecoveryState {
  if (target === 'DELIVERED') return 'DELIVERED';
  if (target === 'RETURNED') return 'RETURNED';
  return 'CLOSED';
}

/**
 * THE SEAM HOOK. Called by the canonical order transition, inside its
 * transaction, after the order row is locked and written, so a case can never
 * disagree with its order:
 *   - INTO RETURNING: the return is owned. An open case moves to
 *     RETURN_REQUIRED (refused while a relay handoff is under way, which rolls
 *     the transition back); with none, a case is born RETURN_REQUIRED.
 *   - INTO a terminal status from custody: the open case resolves with it
 *     (DELIVERED, RETURNED, or CLOSED for any other ending).
 * Every other transition costs nothing here: no query runs.
 */
export async function syncCaseOnOrderTransition(
  tx: Prisma.TransactionClient,
  source: { id: string; status: OrderStatus; riderId: string | null; orderType: string | null },
  target: OrderStatus,
  changedBy: string | null,
  note?: string,
): Promise<void> {
  const actor: CaseActor = { userId: changedBy, role: changedBy ? 'ORDER_TRANSITION' : 'SYSTEM' };
  if (target === 'RETURNING') {
    // The order machine only reaches RETURNING from a rider's custody; a row
    // that is not in that shape has no custody to own.
    if (!source.riderId || source.orderType === 'TAXI' || !RIDER_IN_CUSTODY_STATUSES.includes(source.status)) return;
    const open = await lockOpenCase(tx, source.id);
    if (!open) {
      await openCaseInTransaction(tx, {
        order: source, reason: 'RETURN_STARTED', note: note ?? null, actor, state: 'RETURN_REQUIRED',
      });
      return;
    }
    if (open.state === 'RETURN_REQUIRED') return;
    // The edge table decides; this only gives the refusal its plain words.
    // Today the one open state with no edge into RETURN_REQUIRED is a pending
    // relay handoff.
    if (!isCustodyCaseTransition(open.state, 'RETURN_REQUIRED')) {
      throw new AppError(409, 'RECOVERY_TRANSFER_PENDING',
        'A relay rider is on the way to collect this order. Support must call the handoff off before a return can start.');
    }
    await moveCaseInTransaction(tx, open, 'RETURN_REQUIRED', actor, { details: { orderStatus: 'RETURNING', note: note ?? null } });
    return;
  }
  if (!isTerminalOrderStatus(target) || !isMoverHolding(source.status) || source.orderType === 'TAXI') return;
  const open = await lockOpenCase(tx, source.id);
  if (!open) return;
  const wanted = resolvedStateFor(target);
  const to = isCustodyCaseTransition(open.state, wanted) ? wanted : 'CLOSED';
  await moveCaseInTransaction(tx, open, to, actor, {
    resolution: `Order ${target}`,
    details: { orderStatus: target, note: note ?? null },
  });
}

// ---------------------------------------------------------------------------
// What each party sees. Plain sentences, never "call support" alone: every
// open state says who is handling it and what happens next.
// ---------------------------------------------------------------------------

export type CaseAudience = 'CUSTOMER' | 'VENDOR';

interface CaseSentence { headline: string; body: string }

/** The order facts the sentences need: what kind of order, and how it was paid. */
export interface CaseOrderFacts {
  orderType: string | null;
  paymentMethod: string;
  subtotalBase: number | string | null | undefined | { toString(): string };
}

const gyd = (n: number) => `GY$${Math.round(n).toLocaleString('en-US')}`;

/**
 * The money sentence a return owes each party (owner rulings, 4 Oct 2026):
 *  - CASH: the rider fronted the store the goods' price at pickup, and the
 *    store gives that cash back to the rider when the goods come back.
 *  - MMG: the customer paid the store directly. Swift never holds order money,
 *    so the store refunds the customer itself, and the copy says so.
 * A courier parcel goes back to its sender, who keeps no store money.
 */
function returnMoney(order: CaseOrderFacts, audience: CaseAudience): string {
  if (order.orderType === 'COURIER') return '';
  const fronted = riderFloatForOrder(order);
  if (audience === 'VENDOR') {
    if (fronted > 0) return ` Give the rider back the ${gyd(fronted)} cash they paid you for it.`;
    if (order.paymentMethod === 'MOBILE_MONEY') return ' If the customer paid you by MMG, refund them directly — Swift never holds order money.';
    return '';
  }
  if (order.paymentMethod === 'MOBILE_MONEY') return ' If you paid by MMG, the store refunds you directly — Swift never holds order money.';
  return '';
}

function sentenceFor(state: CustodyRecoveryState, audience: CaseAudience, order: CaseOrderFacts): CaseSentence {
  const courier = order.orderType === 'COURIER';
  const origin = courier ? 'you' : 'the store';
  if (audience === 'VENDOR') {
    switch (state) {
      case 'SUPPORT_HOLD': return { headline: 'Delivery problem after pickup', body: 'The rider has the order and reported a problem. Swift support is deciding the next step.' };
      case 'RETURN_REQUIRED': return { headline: 'Order coming back to you', body: `This order could not be delivered and the rider is bringing it back. Confirm in the app when you have it.${returnMoney(order, audience)}` };
      case 'RELAY_REQUIRED': return { headline: 'Arranging another rider', body: 'The rider cannot finish this delivery. Swift is arranging another rider to take it over.' };
      case 'TRANSFER_IN_PROGRESS': return { headline: 'Another rider is taking over', body: 'A second rider is on the way to collect this order from the first rider.' };
      case 'TRANSFERRED': return { headline: 'New rider has the order', body: 'The order was handed to a new rider, who is delivering it.' };
      case 'DELIVERED': return { headline: 'Delivered', body: 'The order reached the customer.' };
      case 'RETURNED': return { headline: 'Returned', body: `The order is back with you.${returnMoney(order, audience)}` };
      case 'CLOSED': return { headline: 'Recovery closed', body: 'Swift closed this recovery case.' };
    }
  }
  switch (state) {
    case 'SUPPORT_HOLD': return { headline: 'Your rider hit a problem', body: 'Your rider still has your order and reported a problem. Swift support has taken this on and will show the next step here.' };
    case 'RETURN_REQUIRED': return { headline: courier ? 'Parcel coming back to you' : 'Order going back to the store', body: `Your order could not be delivered and is on its way back to ${origin}.${returnMoney(order, audience)}` };
    case 'RELAY_REQUIRED': return { headline: 'Arranging another rider', body: 'Your rider cannot finish this delivery. Swift is arranging another rider to collect it from them.' };
    case 'TRANSFER_IN_PROGRESS': return { headline: 'Another rider is on the way', body: 'A second rider is on the way to collect your order from your first rider and bring it to you.' };
    case 'TRANSFERRED': return { headline: 'A new rider has your order', body: 'Your order was handed to a new rider, who is bringing it to you.' };
    case 'DELIVERED': return { headline: 'Delivered', body: 'Your order was delivered.' };
    case 'RETURNED': return { headline: courier ? 'Parcel returned' : 'Order returned to the store', body: courier ? 'Your parcel is back with you.' : `Your order is back at the store.${returnMoney(order, audience)}` };
    case 'CLOSED': return { headline: 'Recovery closed', body: 'Swift closed this recovery case.' };
  }
}

/** The customer's and the store's view of the order's latest case: state,
 *  whether it is still open, and the sentence. No rider identity, no code. */
export function partyCaseView(
  kase: Pick<CustodyRecoveryCase, 'id' | 'state' | 'updatedAt' | 'ownerUserId'> | null,
  audience: CaseAudience,
  order: CaseOrderFacts,
) {
  if (!kase) return null;
  return {
    caseId: kase.id,
    state: kase.state,
    open: CUSTODY_CASE_LAW[kase.state] === 'OPEN',
    ownedBySupport: kase.ownerUserId !== null,
    ...sentenceFor(kase.state, audience, order),
    updatedAt: kase.updatedAt,
  };
}

/** Only an order that reached a rider's custody can have a case: the party
 *  views skip the read for everything else (bookings, pickups, taxis, orders
 *  still at the store). */
export function mayHaveCase(order: { orderType: string | null; status: OrderStatus; pickedUpAt: Date | null }): boolean {
  return order.orderType !== 'TAXI' && (isMoverHolding(order.status) || order.pickedUpAt !== null);
}

/** The order's latest case (open first, else the most recent). */
export async function latestCaseFor(
  db: Prisma.TransactionClient | { custodyRecoveryCase: Prisma.TransactionClient['custodyRecoveryCase'] },
  orderId: string,
): Promise<CustodyRecoveryCase | null> {
  return db.custodyRecoveryCase.findFirst({
    where: { orderId },
    orderBy: [{ createdAt: 'desc' }],
  });
}
