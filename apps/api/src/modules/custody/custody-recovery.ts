import { randomInt, timingSafeEqual } from 'node:crypto';
import type { CustodyIncidentReason, CustodyRecoveryCase, Prisma, PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { haversineDistance } from '../../utils/distance';
import { runAsSystem } from '../../plugins/tenant-context';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { FloatService, riderFloatForOrder } from '../dispatch/float.service';
import { riderStackingCapacity, reserveRiderLeg, settleRiderLegs } from '../dispatch/concurrency-policy';
import { vehicleCanCarry } from '../dispatch/dispatch.service';
import { handoverAttemptState } from '../handover/handover-security';
import { assertActiveMoverAccount, assertMoverRoleAuthority, lockUserRoleAuthority } from '../mover-authority';
import type { OrderService } from '../order/order.service';
import {
  CUSTODY_CASE_DIRECTABLE,
  CUSTODY_CASE_OPEN_STATES,
  RIDER_FORWARD_CUSTODY_STATUSES,
  RIDER_IN_CUSTODY_STATUSES,
  isCustodyCaseOpen,
} from '../order/order-status';
import {
  CUSTODY_CASE_ENTITY,
  caseDeadline,
  latestCaseFor,
  lockCase,
  moveCaseInTransaction,
  openCaseInTransaction,
  partyCaseView,
  recordCaseEvent,
  type CaseActor,
} from './custody-case';

// ---------------------------------------------------------------------------
// [AF-MOB-006 · S0] CUSTODY RECOVERY — the operations.
//
// The core (custody-case.ts) keeps a case in step with its order. This file is
// what people DO with a case: a rider reports an incident, operations owns it
// and directs a return, a relay or a hold, a relay rider takes the goods over
// with the holder's code, a store confirms the goods came back, and a sweep
// pages humans when a deadline passes with nothing done.
//
// THE TRANSFER is the one that matters most. A relay rider is never the
// order's rider before the transfer, so every rider leg route already refuses
// them: they cannot mark it picked up, delivered or paid. The handoff moves
// custody in ONE transaction, in the claim lock order (user → order → case →
// riders): the order's rider, the relay rider's leg reservation, the cash
// float (it stays with the holder until this moment, then moves with the
// goods), the holder's freed leg, the case and the trail. A wrong code burns an
// attempt in its own commit; after the shared handover limit the transfer
// locks and operations is paged.
// ---------------------------------------------------------------------------

export interface CustodyDeps {
  prisma: PrismaClient;
  io: Server;
  notifications: NotificationService;
}

const CASE_ROOM_EVENT = 'order:recovery';

/** Six digits, from the CSPRNG. */
function newTransferCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** [DS667] The holder's code against the typed one, in constant time. A length
 *  mismatch is a mismatch (the route already admits only six digits). */
function codesMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A code is dead at or past its own expiry; a code with no expiry is dead too
 *  (the database refuses that shape, so it can only mean a damaged row). */
function codeHasExpired(expiresAt: Date | null): boolean {
  return !expiresAt || expiresAt.getTime() <= Date.now();
}

/** The refusal a wrong handoff code gets. Built in ONE place so the first
 *  answer and an idempotent replay of it are word for word the same. */
export function invalidTransferCodeError(remaining: number): AppError {
  return new AppError(400, 'INVALID_TRANSFER_CODE', `That handoff code does not match. ${remaining} attempt(s) remaining.`);
}

/** A relay rider asking about a handoff that is not (or no longer) theirs gets a
 *  sentence, never an internal id (Fable S3). Still a 404. */
function handoffGone(): AppError {
  return new AppError(404, 'HANDOFF_NOT_FOUND', 'This handoff is no longer yours — it was called off or given to another rider.');
}

/** [DS667 S4] The named relay rider is told when the handoff they were asked
 *  to make is off, so nobody travels to a meeting that will not happen. */
async function notifyRelayCalledOff(
  deps: CustodyDeps,
  relayRiderId: string,
  kase: Pick<CustodyRecoveryCase, 'id'>,
  orderNumber: string,
  why: 'called_off' | 'expired',
): Promise<void> {
  const relay = await deps.prisma.rider.findUnique({ where: { id: relayRiderId }, select: { userId: true } }).catch(() => null);
  if (!relay) return;
  await deps.notifications.send({
    userId: relay.userId, type: 'ORDER_UPDATE',
    title: 'Relay handoff called off',
    body: why === 'expired'
      ? `The handoff for order ${orderNumber} expired before it happened. You don't need to meet the other rider.`
      : `Swift called off the handoff for order ${orderNumber}. You don't need to meet the other rider.`,
    data: { kind: 'custody_relay_cancelled', caseId: kase.id, reason: why },
  }).catch(() => {});
}

function gpsText(gps: { lat: number; lng: number }): string {
  return `GPS ${gps.lat.toFixed(5)},${gps.lng.toFixed(5)}`;
}

async function lockOrderRow(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE`;
}

/** The order columns every operation here reads. */
const ORDER_SELECT = {
  id: true, tenantId: true, orderNumber: true, orderType: true, status: true, riderId: true,
  customerId: true, vendorId: true, paymentMethod: true, subtotalBase: true,
  courierPackageSize: true,
} satisfies Prisma.OrderSelect;

type CaseOrder = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

async function readOrder(db: Prisma.TransactionClient | PrismaClient, orderId: string): Promise<CaseOrder> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
  if (!order) throw new NotFoundError('Order', orderId);
  return order;
}

/** Make the acting operator the owner when nobody owns the case yet. */
async function ensureOwner(tx: Prisma.TransactionClient, kase: CustodyRecoveryCase, adminUserId: string): Promise<void> {
  if (kase.ownerUserId) return;
  await tx.custodyRecoveryCase.update({
    where: { id: kase.id },
    data: { ownerUserId: adminUserId, ownerAssignedAt: new Date() },
  });
  await recordCaseEvent(tx, kase, 'OWNER_ASSIGNED', { userId: adminUserId, role: 'ADMIN' }, { ownerUserId: adminUserId, implicit: true });
}

// ── Publication (post-commit only; never fails the caller) ─────────────────

async function vendorOwnerUserId(prisma: PrismaClient, vendorId: string | null): Promise<string | null> {
  if (!vendorId) return null;
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { owner: { select: { userId: true } } } });
  return vendor?.owner?.userId ?? null;
}

/** Tell the customer, the store and the order room what the case now says. */
export async function publishCaseChange(
  deps: CustodyDeps,
  kase: CustodyRecoveryCase,
  order: Pick<CaseOrder, 'id' | 'orderType' | 'customerId' | 'vendorId' | 'status' | 'paymentMethod' | 'subtotalBase'>,
  opts: { notifyCustomer?: boolean; notifyVendor?: boolean } = {},
): Promise<void> {
  try {
    const event = { orderId: order.id, caseId: kase.id, state: kase.state, timestamp: new Date().toISOString() };
    deps.io.to(`order:${order.id}`).emit(CASE_ROOM_EVENT, event);
    if (order.vendorId) deps.io.to(`vendor:${order.vendorId}`).emit(CASE_ROOM_EVENT, event);
  } catch (err) {
    log().warn({ err, orderId: order.id }, 'custody case socket publication failed after commit');
  }
  if (opts.notifyCustomer !== false) {
    const view = partyCaseView(kase, 'CUSTOMER', order)!;
    await deps.notifications.send({
      userId: order.customerId, type: 'ORDER_UPDATE', title: view.headline, body: view.body,
      data: { orderId: order.id, status: order.status, recoveryState: kase.state },
    }).catch(() => {});
  }
  if (opts.notifyVendor) {
    const ownerId = await vendorOwnerUserId(deps.prisma, order.vendorId).catch(() => null);
    if (ownerId) {
      const view = partyCaseView(kase, 'VENDOR', order)!;
      await deps.notifications.send({
        userId: ownerId, type: 'ORDER_UPDATE', title: view.headline, body: view.body, audience: 'business',
        data: { orderId: order.id, recoveryState: kase.state },
      }).catch(() => {});
    }
  }
}

/** Page operations about a case. Scoped to the order's tenant. */
export async function pageOps(
  deps: CustodyDeps,
  order: Pick<CaseOrder, 'id' | 'tenantId' | 'orderNumber'>,
  kase: Pick<CustodyRecoveryCase, 'id' | 'state'>,
  event: 'opened' | 'overdue' | 'relay_declined' | 'transfer_locked',
  body: string,
): Promise<void> {
  const titles = {
    opened: 'Delivery needs recovery after pickup',
    overdue: 'Custody case overdue — nobody has acted',
    relay_declined: 'Relay rider declined a custody handoff',
    transfer_locked: 'Custody handoff locked after wrong codes',
  } as const;
  await notifyAdmins(deps.prisma, deps.notifications, {
    tenantId: order.tenantId ?? null,
    title: titles[event],
    body: `Order ${order.orderNumber}: ${body}`,
    // The kind is a literal on purpose: the mobile notification census scans for it.
    data: { kind: 'ops_custody_case', event, orderId: order.id, caseId: kase.id, state: kase.state },
  }).catch((err) => log().warn({ err, orderId: order.id }, 'custody case page failed'));
}

// ── The holder ──────────────────────────────────────────────────────────────

export interface ReportInput {
  orderId: string;
  riderId: string;
  userId: string;
  reason: CustodyIncidentReason;
  note?: string | null;
  gps?: { lat: number; lng: number } | null;
}

/** The holder reports an incident after pickup: the order's ONE case opens
 *  (or the open one is returned), operations is paged, the customer told. */
export async function reportIncident(deps: CustodyDeps, input: ReportInput) {
  const result = await deps.prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, input.orderId);
    const order = await readOrder(tx, input.orderId);
    if (order.riderId !== input.riderId || order.orderType === 'TAXI') throw new NotFoundError('Order', input.orderId);
    if (!RIDER_IN_CUSTODY_STATUSES.includes(order.status)) {
      throw new AppError(409, 'NOT_IN_CUSTODY',
        'You have not picked this order up yet — use "Hand back" instead, which re-opens it for another rider.');
    }
    const opened = await openCaseInTransaction(tx, {
      order, reason: input.reason, note: input.note ?? null,
      actor: { userId: input.userId, role: 'RIDER' }, gps: input.gps ?? null,
      state: order.status === 'RETURNING' ? 'RETURN_REQUIRED' : 'SUPPORT_HOLD',
    });
    return { ...opened, order };
  });
  if (result.created) {
    await pageOps(deps, result.order, result.kase, 'opened',
      `the rider reported ${result.kase.reason.toLowerCase().replace(/_/g, ' ')} after pickup${result.order.paymentMethod === 'CASH' ? ' (they fronted the store cash)' : ''}. Claim the case and decide: hold, return or relay.`);
    await publishCaseChange(deps, result.kase, result.order);
  }
  return result;
}

/** What the rider holding the order sees about its latest case (after a
 *  verified handoff that is the relay rider, who now holds it). The handoff
 *  code is shown ONLY to the current holder while a transfer is pending. */
export async function holderView(deps: CustodyDeps, orderId: string, riderId: string) {
  const order = await readOrder(deps.prisma, orderId);
  const kase = await latestCaseFor(deps.prisma, orderId);
  if (!kase || (order.riderId !== riderId && kase.holderRiderId !== riderId)) throw new NotFoundError('RecoveryCase', orderId);
  const isHolder = order.riderId === riderId && kase.holderRiderId === riderId;
  // [DS667 · Fable S2] The handoff code lives until the handoff deadline. Past
  // it the code is never shown (the server refuses it), and the holder is told
  // it expired and that support is arranging the handoff again.
  const pendingHandoff = isHolder && kase.state === 'TRANSFER_IN_PROGRESS';
  // Keyed on the code's OWN expiry, never the case deadline a sweep may bump.
  const codeExpired = pendingHandoff && codeHasExpired(kase.transferCodeExpiresAt);
  const relay = kase.relayRiderId
    ? await deps.prisma.rider.findUnique({ where: { id: kase.relayRiderId }, select: { user: { select: { firstName: true } }, vehicleType: true } })
    : null;
  const float = riderFloatForOrder(order);
  return {
    caseId: kase.id,
    orderId,
    state: kase.state,
    open: isCustodyCaseOpen(kase.state),
    version: kase.version,
    reason: kase.reason,
    ownedBySupport: kase.ownerUserId !== null,
    deadlineAt: kase.deadlineAt,
    youHoldTheGoods: isHolder,
    relay: relay && kase.state === 'TRANSFER_IN_PROGRESS'
      ? { firstName: relay.user.firstName, vehicleType: relay.vehicleType }
      : null,
    // The holder SHOWS this; the relay rider types it. Nobody else reads it.
    transferCode: pendingHandoff && !codeExpired ? kase.transferCode : null,
    transferCodeExpiresAt: pendingHandoff ? kase.transferCodeExpiresAt : null,
    codeExpired,
    // On cash the holder fronted the store; the float moves with the goods.
    floatToCollect: pendingHandoff && !codeExpired && float > 0 ? float : 0,
    instruction: codeExpired
      ? 'The handoff code expired before the other rider arrived. Keep the order with you — Swift support is arranging the handoff again.'
      : holderInstruction(kase, float, order.orderType),
  };
}

function holderInstruction(kase: CustodyRecoveryCase, float: number, orderType: string | null): string {
  switch (kase.state) {
    case 'SUPPORT_HOLD': return 'Keep the order with you and stay where it is safe. Swift support has the case and will tell you the next step here.';
    case 'RETURN_REQUIRED': return float > 0 && orderType !== 'COURIER'
      ? `Take the order back to the store. When they confirm they have it, the store gives you back the GY$${Math.round(float).toLocaleString('en-US')} cash you paid for it.`
      : 'Take the order back to where you collected it. The store (or the sender) confirms when they have it.';
    case 'RELAY_REQUIRED': return 'Keep the order with you. Swift is finding another rider to collect it from you.';
    case 'TRANSFER_IN_PROGRESS': return float > 0
      ? `Another rider is coming to collect the order. Show them your handoff code only once they have the order's cash float for you (GY$${Math.round(float).toLocaleString('en-US')}).`
      : 'Another rider is coming to collect the order. Show them your handoff code when you hand it over.';
    // Only the CURRENT holder can read a case, so after a verified handoff the
    // reader is the relay rider who took the order over.
    case 'TRANSFERRED': return 'Another rider handed this order to you. Deliver it as normal.';
    case 'DELIVERED': return 'The order was delivered.';
    case 'RETURNED': return 'The order was returned.';
    case 'CLOSED': return 'Swift closed this case.';
  }
}

// ── The relay rider ─────────────────────────────────────────────────────────

/** A relay rider's pending handoffs: where to meet the holder and what to
 *  bring. No customer identity or address until custody is theirs. */
export async function relayTasks(deps: CustodyDeps, riderId: string) {
  const cases = await deps.prisma.custodyRecoveryCase.findMany({
    // An expired handoff is not a task: its code is refused (DS667).
    where: { relayRiderId: riderId, state: 'TRANSFER_IN_PROGRESS', transferCodeExpiresAt: { gt: new Date() } },
    orderBy: { updatedAt: 'desc' },
  });
  const out = [];
  for (const kase of cases) {
    const order = await readOrder(deps.prisma, kase.orderId);
    const holder = await deps.prisma.rider.findUnique({
      where: { id: kase.holderRiderId },
      select: { currentLat: true, currentLng: true, lastLocationUpdate: true, user: { select: { firstName: true } } },
    });
    const float = riderFloatForOrder(order);
    out.push({
      caseId: kase.id,
      version: kase.version,
      orderNumber: order.orderNumber,
      orderType: order.orderType,
      packageSize: order.courierPackageSize,
      holder: holder ? {
        firstName: holder.user.firstName,
        lat: holder.currentLat, lng: holder.currentLng, lastSeenAt: holder.lastLocationUpdate,
      } : null,
      floatToBring: float,
      deadlineAt: kase.deadlineAt,
      expiresAt: kase.transferCodeExpiresAt,
      instruction: float > 0
        ? `Meet ${holder?.user.firstName ?? 'the rider'}, give them the order's cash float (GY$${Math.round(float).toLocaleString('en-US')}), take the order and enter the code they show you.`
        : `Meet ${holder?.user.firstName ?? 'the rider'}, take the order and enter the code they show you.`,
    });
  }
  return out;
}

export interface TransferInput {
  caseId: string;
  relayRiderId: string;
  relayUserId: string;
  code: string;
  gps: { lat: number; lng: number };
  version?: number;
}

/**
 * THE VERIFIED HANDOFF. One custody holder at a time: until this commits the
 * holder keeps the order, its float and every door; after it, the relay rider
 * does, and the holder is free. Nothing in between is ever visible.
 */
export async function transferCustody(deps: CustodyDeps, input: TransferInput) {
  const outcome = await deps.prisma.$transaction(async (tx) => {
    // Claim lock order: the relay rider's user authority, then the order,
    // then the case, then rider rows (reservation and float).
    const authority = await lockUserRoleAuthority(tx, input.relayUserId);
    assertActiveMoverAccount(authority.status);
    assertMoverRoleAuthority(authority.activeRole, 'RIDER');
    const pre = await tx.custodyRecoveryCase.findUnique({ where: { id: input.caseId }, select: { orderId: true } });
    if (!pre) throw handoffGone();
    await lockOrderRow(tx, pre.orderId);
    const kase = await lockCase(tx, input.caseId);
    if (!kase || kase.relayRiderId !== input.relayRiderId) throw handoffGone();
    if (kase.state !== 'TRANSFER_IN_PROGRESS' || !kase.transferCode) {
      throw new AppError(409, 'TRANSFER_NOT_PENDING', 'This handoff is no longer pending — it was completed or called off.');
    }
    if (input.version !== undefined && input.version !== kase.version) {
      throw new AppError(409, 'RECOVERY_STALE', 'This handoff changed since your screen loaded — refresh and try again.');
    }
    // [DS667 S3 · Fable r2] The code lives until its OWN expiry, set when it
    // was minted and never moved — a later bump of the case deadline can never
    // revive it. The escalation sweep voids it and returns the case to
    // RELAY_REQUIRED; naming the relay rider again mints a fresh code.
    if (codeHasExpired(kase.transferCodeExpiresAt)) {
      throw new AppError(409, 'TRANSFER_CODE_EXPIRED', 'This handoff code has expired. Swift support will arrange the handoff again.');
    }
    const { locked, remaining } = handoverAttemptState(kase.transferAttempts);
    if (locked) {
      throw new AppError(409, 'MAX_ATTEMPTS', 'Too many wrong handoff codes. Swift support has been told and will sort out the handoff.');
    }
    if (!codesMatch(input.code, kase.transferCode)) {
      // Burned in its own commit: the refusal is raised after this transaction.
      await tx.custodyRecoveryCase.update({ where: { id: kase.id }, data: { transferAttempts: { increment: 1 } } });
      await recordCaseEvent(tx, kase, 'TRANSFER_CODE_FAILED', { userId: input.relayUserId, role: 'RELAY_RIDER' }, {
        attempt: kase.transferAttempts + 1, gps: input.gps,
      });
      return { kind: 'WRONG_CODE' as const, remaining, kase };
    }

    const order = await readOrder(tx, kase.orderId);
    if (order.riderId !== kase.holderRiderId) {
      throw new AppError(409, 'HOLDER_CHANGED', 'The order is no longer with the rider who started this handoff.');
    }
    if (!RIDER_FORWARD_CUSTODY_STATUSES.includes(order.status)) {
      throw new AppError(409, 'NOT_IN_CUSTODY', `This order can no longer be handed over (${order.status}).`);
    }
    if (order.customerId === input.relayUserId) {
      throw new AppError(409, 'SELF_OWN_ORDER', 'You cannot take over a delivery placed by your own account.');
    }
    const holderRiderId = kase.holderRiderId;

    // 1. The order's one holder becomes the relay rider.
    await tx.order.update({ where: { id: order.id }, data: { riderId: input.relayRiderId } });
    // 2. The relay rider takes it as a leg like any claim: online, documents
    //    current, account active, and room under the stacking capacity.
    const capacity = await riderStackingCapacity(deps.prisma);
    if (!(await reserveRiderLeg(tx, input.relayRiderId, order.id, capacity))) {
      throw new AppError(409, 'RELAY_NOT_AVAILABLE', 'You must be online and free to take this order over.');
    }
    // 3. The float moves with the goods: committed to the relay rider (guarded
    //    by their headroom), released from the holder, in this same commit.
    const float = riderFloatForOrder(order);
    if (float > 0) {
      const floats = new FloatService(tx);
      if (!(await floats.commit(tx, input.relayRiderId, float))) {
        throw new AppError(409, 'FLOAT_EXCEEDED',
          `This cash order needs GY$${Math.round(float).toLocaleString('en-US')} of float headroom; your other live orders have used it up.`);
      }
      await floats.release(tx, holderRiderId, float);
    }
    // 4. The holder's leg ends (pointer and availability through the seam).
    await settleRiderLegs(tx, holderRiderId, { prisma: deps.prisma, excludeOrderId: order.id });
    // 5. The order's own history says who holds it now.
    const holder = await tx.rider.findUnique({
      where: { id: holderRiderId }, select: { currentLat: true, currentLng: true, lastLocationUpdate: true },
    });
    const distanceM = holder?.currentLat != null && holder.currentLng != null
      ? Math.round(haversineDistance(holder.currentLat, holder.currentLng, input.gps.lat, input.gps.lng) * 1000)
      : null;
    await tx.orderStatusLog.create({
      data: {
        orderId: order.id, status: order.status, changedBy: input.relayUserId,
        note: `Custody handed to a relay rider — holder's handoff code verified — ${gpsText(input.gps)}`,
      },
    });
    // 6. The case resolves; the relay rider is the holder of record.
    const moved = await moveCaseInTransaction(tx, kase, 'TRANSFERRED', { userId: input.relayUserId, role: 'RELAY_RIDER' }, {
      data: { holderRiderId: input.relayRiderId },
      resolution: 'Custody transferred to the relay rider',
      details: {
        fromRiderId: holderRiderId, toRiderId: input.relayRiderId, relayGps: input.gps,
        holderLastFix: holder?.currentLat != null ? { lat: holder.currentLat, lng: holder.currentLng, at: holder.lastLocationUpdate } : null,
        distanceFromHolderLastFixM: distanceM, floatMoved: float,
      },
    });
    return { kind: 'TRANSFERRED' as const, kase: moved, order: { ...order, riderId: input.relayRiderId }, holderRiderId };
  });

  if (outcome.kind === 'WRONG_CODE') {
    if (outcome.remaining === 0) {
      const order = await readOrder(deps.prisma, outcome.kase.orderId);
      await pageOps(deps, order, outcome.kase, 'transfer_locked', 'the relay rider entered the wrong handoff code too many times. Check both riders and re-plan the relay.');
    }
    // [DS667 S2] Returned, not thrown: the attempt is already burned and
    // committed, so the route stores this refusal under the request's
    // Idempotency-Key — a retry of the same request replays it instead of
    // burning a second attempt. The route raises invalidTransferCodeError.
    return { kind: 'WRONG_CODE' as const, remaining: outcome.remaining };
  }
  await publishCaseChange(deps, outcome.kase, outcome.order, { notifyVendor: false });
  return outcome;
}

/** The relay rider says no: the case goes back to RELAY_REQUIRED and
 *  operations is paged to name someone else. */
export async function declineRelay(deps: CustodyDeps, input: { caseId: string; relayRiderId: string; relayUserId: string; reason?: string }) {
  const result = await deps.prisma.$transaction(async (tx) => {
    const pre = await tx.custodyRecoveryCase.findUnique({ where: { id: input.caseId }, select: { orderId: true } });
    if (!pre) throw handoffGone();
    await lockOrderRow(tx, pre.orderId);
    const kase = await lockCase(tx, input.caseId);
    if (!kase || kase.relayRiderId !== input.relayRiderId || kase.state !== 'TRANSFER_IN_PROGRESS') {
      throw handoffGone();
    }
    const moved = await moveCaseInTransaction(tx, kase, 'RELAY_REQUIRED', { userId: input.relayUserId, role: 'RELAY_RIDER' }, {
      details: { declined: true, reason: input.reason ?? null },
    });
    return { kase: moved, order: await readOrder(tx, kase.orderId) };
  });
  await pageOps(deps, result.order, result.kase, 'relay_declined', `the relay rider declined${input.reason ? ` (${input.reason})` : ''}. Name another rider.`);
  return result;
}

// ── Operations ──────────────────────────────────────────────────────────────

/** Admin list: open cases first by deadline, then recently resolved. */
export async function listCases(prisma: PrismaClient, opts: { open: boolean; take?: number }) {
  const cases = await prisma.custodyRecoveryCase.findMany({
    where: opts.open ? { state: { in: CUSTODY_CASE_OPEN_STATES } } : {},
    orderBy: opts.open ? { deadlineAt: 'asc' } : { updatedAt: 'desc' },
    take: Math.min(Math.max(opts.take ?? 50, 1), 200),
    omit: { transferCode: true },
    include: { order: { select: { orderNumber: true, orderType: true, status: true, paymentMethod: true, vendor: { select: { name: true } } } } },
  });
  const now = Date.now();
  return cases.map((kase) => ({
    ...kase,
    overdue: isCustodyCaseOpen(kase.state) && kase.deadlineAt.getTime() <= now,
  }));
}

/** Admin detail: the case (never its code), the people, and the trail. */
export async function caseDetail(prisma: PrismaClient, caseId: string) {
  const kase = await prisma.custodyRecoveryCase.findUnique({
    where: { id: caseId },
    // The handoff code is the holder's alone; operations never reads it.
    omit: { transferCode: true },
    include: { order: { select: { id: true, orderNumber: true, orderType: true, status: true, paymentMethod: true, subtotalBase: true, riderId: true, vendor: { select: { name: true } } } } },
  });
  if (!kase) throw new NotFoundError('RecoveryCase', caseId);
  const riderIds = [kase.holderRiderId, kase.relayRiderId].filter((x): x is string => !!x);
  const riders = await prisma.rider.findMany({
    where: { id: { in: riderIds } },
    select: { id: true, currentLat: true, currentLng: true, lastLocationUpdate: true, isOnline: true, user: { select: { firstName: true, lastName: true, phone: true } } },
  });
  const trail = await prisma.auditLog.findMany({
    where: { entity: CUSTODY_CASE_ENTITY, entityId: caseId },
    orderBy: { createdAt: 'asc' },
    select: { action: true, userId: true, changes: true, createdAt: true },
  });
  const { order, ...rest } = kase;
  return {
    ...rest,
    order: { ...order, subtotalBase: Number(order.subtotalBase), floatAttached: riderFloatForOrder(order) },
    holder: riders.find((r) => r.id === kase.holderRiderId) ?? null,
    relay: riders.find((r) => r.id === kase.relayRiderId) ?? null,
    trail,
  };
}

/** An operator takes ownership (or hands it to a named colleague). */
export async function claimCase(deps: CustodyDeps, input: { caseId: string; adminUserId: string; ownerUserId?: string }) {
  const ownerUserId = input.ownerUserId ?? input.adminUserId;
  if (ownerUserId !== input.adminUserId) {
    const owner = await deps.prisma.user.findFirst({
      where: { id: ownerUserId, roles: { hasSome: ['ADMIN', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!owner) throw new AppError(400, 'OWNER_NOT_OPERATOR', 'A case can only be owned by an active operator.');
  }
  return deps.prisma.$transaction(async (tx) => {
    const pre = await tx.custodyRecoveryCase.findUnique({ where: { id: input.caseId }, select: { orderId: true } });
    if (!pre) throw new NotFoundError('RecoveryCase', input.caseId);
    await lockOrderRow(tx, pre.orderId);
    const kase = await lockCase(tx, input.caseId);
    if (!kase || !isCustodyCaseOpen(kase.state)) throw new AppError(409, 'RECOVERY_CLOSED', 'This recovery case is already resolved.');
    const updated = await tx.custodyRecoveryCase.update({
      where: { id: kase.id },
      data: { ownerUserId, ownerAssignedAt: new Date() },
    });
    await recordCaseEvent(tx, kase, 'OWNER_ASSIGNED', { userId: input.adminUserId, role: 'ADMIN' }, {
      ownerUserId, previousOwnerUserId: kase.ownerUserId,
    });
    return updated;
  });
}

export type DirectOutcome = (typeof CUSTODY_CASE_DIRECTABLE)[number];

/**
 * Operations decides: hold, relay, or return. A return moves the ORDER to
 * RETURNING through the canonical seam (which moves the case with it); the
 * other two move the case only — the goods stay with the holder.
 */
export async function directCase(
  deps: CustodyDeps & { orderService: OrderService },
  input: { caseId: string; adminUserId: string; outcome: DirectOutcome; reason: string; ipAddress?: string; userAgent?: string },
) {
  const pre = await deps.prisma.custodyRecoveryCase.findUnique({ where: { id: input.caseId } });
  if (!pre) throw new NotFoundError('RecoveryCase', input.caseId);
  const actor: CaseActor = { userId: input.adminUserId, role: 'ADMIN' };

  if (input.outcome === 'RETURN_REQUIRED') {
    if (!isCustodyCaseOpen(pre.state)) throw new AppError(409, 'RECOVERY_CLOSED', 'This recovery case is already resolved.');
    const committed = await deps.orderService.transitionOrderAtomically({
      orderId: pre.orderId,
      target: 'RETURNING',
      allowedFrom: RIDER_FORWARD_CUSTODY_STATUSES,
      expectedRiderId: pre.holderRiderId,
      changedBy: input.adminUserId,
      note: `Operations directed a return — ${input.reason}`,
      withinTransaction: async (tx, locked) => {
        const kase = await lockCase(tx, pre.id);
        if (!kase || kase.state !== 'RETURN_REQUIRED') {
          throw new AppError(409, 'RECOVERY_STALE', 'This recovery case changed while the action was in progress — refresh and try again.');
        }
        await ensureOwner(tx, kase, input.adminUserId);
        await recordCaseEvent(tx, kase, 'DIRECTED', actor, { outcome: 'RETURN_REQUIRED', reason: input.reason });
        if (locked.orderType === 'COURIER') {
          await tx.order.update({
            where: { id: locked.id },
            data: { courierReturnReason: input.reason, courierReturnRequestedAt: new Date() },
          });
        }
      },
      operatorAudit: {
        userId: input.adminUserId, action: 'CUSTODY_CASE_DIRECT', entity: 'Order', entityId: pre.orderId,
        changes: (previousStatus) => ({ caseId: pre.id, outcome: 'RETURN_REQUIRED', reason: input.reason, previousStatus }),
        ipAddress: input.ipAddress, userAgent: input.userAgent,
      },
      invalidStatus: (current) => new AppError(409, 'NOT_IN_CUSTODY', `A return can only start while the order is on its way to the customer (it is ${current}).`),
    });
    const kase = await deps.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: pre.id } });
    await publishCaseChange(deps, kase, committed.order, { notifyVendor: true });
    return kase;
  }

  const result = await deps.prisma.$transaction(async (tx) => {
    await lockOrderRow(tx, pre.orderId);
    const kase = await lockCase(tx, pre.id);
    if (!kase) throw new NotFoundError('RecoveryCase', pre.id);
    const order = await readOrder(tx, kase.orderId);
    if (order.riderId !== kase.holderRiderId) {
      throw new AppError(409, 'HOLDER_CHANGED', 'The order is no longer with the rider this case is about.');
    }
    await ensureOwner(tx, kase, input.adminUserId);
    // A pending handoff that operations calls off: its relay rider is told.
    const calledOffRelay = kase.state === 'TRANSFER_IN_PROGRESS' ? kase.relayRiderId : null;
    const moved = await moveCaseInTransaction(tx, kase, input.outcome, actor, {
      details: { directed: true, reason: input.reason },
    });
    await tx.auditLog.create({
      data: {
        userId: input.adminUserId, action: 'CUSTODY_CASE_DIRECT', entity: 'Order', entityId: order.id,
        changes: { caseId: kase.id, outcome: input.outcome, reason: input.reason, previousState: kase.state },
        ipAddress: input.ipAddress, userAgent: input.userAgent,
      },
    });
    return { kase: moved, order, calledOffRelay };
  });
  if (result.calledOffRelay) await notifyRelayCalledOff(deps, result.calledOffRelay, result.kase, result.order.orderNumber, 'called_off');
  await publishCaseChange(deps, result.kase, result.order);
  return result.kase;
}

/** Operations names the relay rider: the handoff code is minted for the
 *  holder, the relay rider sees the task, and custody does NOT move yet. */
export async function assignRelay(
  deps: CustodyDeps,
  input: { caseId: string; adminUserId: string; riderId: string; reason: string; ipAddress?: string; userAgent?: string },
) {
  const result = await deps.prisma.$transaction(async (tx) => {
    const pre = await tx.custodyRecoveryCase.findUnique({ where: { id: input.caseId }, select: { orderId: true } });
    if (!pre) throw new NotFoundError('RecoveryCase', input.caseId);
    await lockOrderRow(tx, pre.orderId);
    const kase = await lockCase(tx, input.caseId);
    if (!kase) throw new NotFoundError('RecoveryCase', input.caseId);
    if (kase.state !== 'RELAY_REQUIRED') {
      throw new AppError(409, 'RECOVERY_STEP_NOT_ALLOWED', 'Direct a relay first; a relay rider is named only while a relay is required.');
    }
    const order = await readOrder(tx, kase.orderId);
    if (order.riderId !== kase.holderRiderId || !RIDER_FORWARD_CUSTODY_STATUSES.includes(order.status)) {
      throw new AppError(409, 'NOT_IN_CUSTODY', 'The order is no longer on its way with the holder.');
    }
    const relay = await tx.rider.findUnique({
      where: { id: input.riderId },
      select: { id: true, userId: true, riderType: true, vehicleType: true, isOnline: true, user: { select: { status: true, firstName: true } } },
    });
    if (!relay) throw new NotFoundError('Rider', input.riderId);
    if (relay.id === kase.holderRiderId) throw new AppError(400, 'RELAY_IS_HOLDER', 'The relay rider must be someone other than the rider holding the order.');
    if (relay.userId === order.customerId) throw new AppError(400, 'SELF_OWN_ORDER', 'That rider placed this order.');
    if (relay.user.status !== 'ACTIVE') throw new AppError(400, 'RELAY_NOT_ACTIVE', 'That rider account is not active.');
    if (!relay.isOnline) throw new AppError(400, 'RELAY_OFFLINE', 'That rider is offline.');
    const needsCourier = order.orderType === 'COURIER';
    const serves = needsCourier ? relay.riderType === 'COURIER' || relay.riderType === 'BOTH' : relay.riderType === 'DELIVERY' || relay.riderType === 'BOTH';
    if (!serves) throw new AppError(400, 'WRONG_SERVICE_TYPE', `That rider does not do ${needsCourier ? 'courier' : 'delivery'} work.`);
    if (needsCourier && order.courierPackageSize && !vehicleCanCarry(relay.vehicleType, order.courierPackageSize)) {
      throw new AppError(400, 'VEHICLE_TOO_SMALL', 'That rider’s vehicle cannot carry this parcel.');
    }
    await ensureOwner(tx, kase, input.adminUserId);
    const moved = await moveCaseInTransaction(tx, kase, 'TRANSFER_IN_PROGRESS', { userId: input.adminUserId, role: 'ADMIN' }, {
      data: { relayRiderId: relay.id, transferCode: newTransferCode(), transferCodeExpiresAt: caseDeadline('TRANSFER_IN_PROGRESS', new Date()), transferAttempts: 0 },
      // The code itself is never written to the trail.
      details: { relayRiderId: relay.id, reason: input.reason },
    });
    await tx.auditLog.create({
      data: {
        userId: input.adminUserId, action: 'CUSTODY_CASE_RELAY', entity: 'Order', entityId: order.id,
        changes: { caseId: kase.id, relayRiderId: relay.id, reason: input.reason },
        ipAddress: input.ipAddress, userAgent: input.userAgent,
      },
    });
    const holder = await tx.rider.findUnique({ where: { id: kase.holderRiderId }, select: { userId: true } });
    return { kase: moved, order, relay, holderUserId: holder?.userId ?? null };
  });
  await deps.notifications.send({
    userId: result.relay.userId, type: 'ORDER_UPDATE',
    title: 'Relay handoff for you',
    body: `Swift asked you to take over order ${result.order.orderNumber} from another rider. Open the app to see where to meet them.`,
    data: { kind: 'custody_relay_assigned', caseId: result.kase.id },
  }).catch(() => {});
  if (result.holderUserId) {
    await deps.notifications.send({
      userId: result.holderUserId, type: 'ORDER_UPDATE',
      title: 'Another rider is coming for the order',
      body: `${result.relay.user.firstName ?? 'A rider'} is coming to take order ${result.order.orderNumber} over. Open it to see your handoff code.`,
      data: { kind: 'custody_handoff_code', orderId: result.order.id, caseId: result.kase.id },
    }).catch(() => {});
  }
  await publishCaseChange(deps, result.kase, result.order);
  return result.kase;
}

/**
 * The goods are back: the store confirms (a store order), or an operator does
 * when nobody else can. The order moves RETURNING → RETURNED through the
 * canonical seam, which resolves the case and releases the holder's float.
 */
export async function confirmReturn(
  deps: CustodyDeps & { orderService: OrderService },
  input: { orderId: string; actor: CaseActor; reason?: string; ipAddress?: string; userAgent?: string },
) {
  const pre = await deps.prisma.custodyRecoveryCase.findFirst({
    where: { orderId: input.orderId, state: 'RETURN_REQUIRED' },
  });
  if (!pre) throw new AppError(409, 'NO_RETURN_PENDING', 'This order has no return waiting to be confirmed.');
  const committed = await deps.orderService.transitionOrderAtomically({
    orderId: input.orderId,
    target: 'RETURNED',
    allowedFrom: ['RETURNING'],
    expectedRiderId: pre.holderRiderId,
    changedBy: input.actor.userId,
    note: input.actor.role === 'VENDOR' ? 'The store confirmed the goods are back' : `Operations confirmed the return — ${input.reason ?? ''}`.trim(),
    withinTransaction: async (tx, locked) => {
      await recordCaseEvent(tx, pre, 'RETURN_CONFIRMED', input.actor, { reason: input.reason ?? null });
      if (locked.orderType === 'COURIER') {
        await tx.order.update({ where: { id: locked.id }, data: { courierReturnedAt: new Date() } });
      }
    },
    ...(input.actor.role === 'ADMIN' && input.actor.userId ? {
      operatorAudit: {
        userId: input.actor.userId, action: 'CUSTODY_CASE_CONFIRM_RETURN', entity: 'Order', entityId: input.orderId,
        changes: (previousStatus: string) => ({ caseId: pre.id, reason: input.reason ?? null, previousStatus }),
        ipAddress: input.ipAddress, userAgent: input.userAgent,
      },
    } : {}),
    invalidStatus: (current) => new AppError(409, 'NOT_RETURNING', `The order is not on its way back (it is ${current}).`),
  });
  const kase = await deps.prisma.custodyRecoveryCase.findUniqueOrThrow({ where: { id: pre.id } });
  await publishCaseChange(deps, kase, committed.order);
  return kase;
}

// ── Timeouts page humans ────────────────────────────────────────────────────

/**
 * Every open case whose deadline has passed pages operations of its tenant,
 * counts the escalation and re-arms the deadline, so a case nobody acts on
 * keeps paging until a human does. Runs in the stale-movers job. Idempotent
 * per deadline: the re-check on the locked row means two sweeps page once.
 */
export async function escalateOverdueCases(deps: CustodyDeps, now = new Date()): Promise<string[]> {
  return runAsSystem('custody-recovery-escalation', async () => {
    const due = await deps.prisma.custodyRecoveryCase.findMany({
      where: { state: { in: CUSTODY_CASE_OPEN_STATES }, deadlineAt: { lte: now } },
      orderBy: { deadlineAt: 'asc' },
      take: 100,
      select: { id: true, orderId: true },
    });
    const escalated: string[] = [];
    for (const row of due) {
      const result = await deps.prisma.$transaction(async (tx) => {
        await lockOrderRow(tx, row.orderId);
        const kase = await lockCase(tx, row.id);
        if (!kase || !isCustodyCaseOpen(kase.state) || kase.deadlineAt > now) return null;
        // [DS667 S3] A handoff that did not happen by its deadline EXPIRES: the
        // code is voided and the case goes back to RELAY_REQUIRED (one
        // declared edge, through the one mover), so operations names a rider
        // again and a fresh code is minted. The relay rider is told after commit.
        const expiredRelay = kase.state === 'TRANSFER_IN_PROGRESS' ? kase.relayRiderId : null;
        const base = expiredRelay
          ? await moveCaseInTransaction(tx, kase, 'RELAY_REQUIRED', { userId: null, role: 'SYSTEM' }, {
            details: { expired: true, relayRiderId: expiredRelay }, now,
          })
          : kase;
        const updated = await tx.custodyRecoveryCase.update({
          where: { id: kase.id },
          data: { escalationCount: { increment: 1 }, lastEscalatedAt: now, deadlineAt: caseDeadline(base.state, now) },
        });
        await recordCaseEvent(tx, kase, 'ESCALATED', { userId: null, role: 'SYSTEM' }, {
          state: kase.state, overdueSince: kase.deadlineAt, escalation: kase.escalationCount + 1,
          ownerUserId: kase.ownerUserId, ...(expiredRelay ? { handoffExpired: true } : {}),
        });
        return { kase: updated, order: await readOrder(tx, kase.orderId), expiredRelay };
      }).catch((err) => {
        log().warn({ err, caseId: row.id }, 'custody escalation failed for one case');
        return null;
      });
      if (!result) continue;
      if (result.expiredRelay) {
        await notifyRelayCalledOff(deps, result.expiredRelay, result.kase, result.order.orderNumber, 'expired');
        await pageOps(deps, result.order, result.kase, 'overdue',
          `the relay handoff expired before it happened (escalation ${result.kase.escalationCount}). The code is void; name a relay rider again or change the plan.`);
        escalated.push(row.id);
        continue;
      }
      const stateWords = result.kase.state.toLowerCase().replace(/_/g, ' ');
      await pageOps(deps, result.order, result.kase, 'overdue',
        `${stateWords} past its deadline with nothing done (escalation ${result.kase.escalationCount}). ${result.kase.ownerUserId ? 'The owner has not acted.' : 'Nobody owns it yet.'}`);
      escalated.push(row.id);
    }
    return escalated;
  });
}
