import { Prisma, type MoverRole, type OrderStatus, type UserRole, type UserStatus } from '@prisma/client';
import { freshRidePinReset } from './rides/ride-pin';
import type { FastifyInstance } from 'fastify';
import { AppError, ConflictError, NotFoundError } from '../utils/errors';
import { makeDispatchService } from './dispatch/dispatch.service';
import { FloatService } from './dispatch/float.service';
import { closeOnlineSession } from './rider/online-hours';
import { processMoverRevocationOutboxById } from './mover-revocation-outbox';
import { TERMINAL_ORDER_STATUSES } from './order/order-status';
import { settleRiderLegs } from './dispatch/concurrency-policy';
import {
  hasTaxiPassengerCustody,
  lockTaxiOrderForCustodyDecision,
} from './rides/passenger-custody';
import { positiveDurationMs, withTimeout } from '../utils/async-lifecycle';
import { disconnectUserSockets } from '../utils/socket-revocation';

/**
 * Serialize every server-side role-authority transition on the User row.
 *
 * A mover can tap GO on one device while another device switches the same
 * account back to Swift/Business. Locking this row makes those transitions
 * have one database order instead of letting the last profile write silently
 * resurrect supply after the mover UI and GPS have stopped.
 */
export async function lockUserRoleAuthority(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{
  activeRole: UserRole;
  lastMoverRole: MoverRole | null;
  roles: UserRole[];
  status: UserStatus;
}> {
  const rows = await tx.$queryRaw<Array<{
    activeRole: UserRole;
    lastMoverRole: MoverRole | null;
    roles: UserRole[];
    status: UserStatus;
  }>>`
    SELECT "activeRole", "lastMoverRole", "roles", "status"
    FROM "users"
    WHERE "id" = ${userId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('User');
  return row;
}

/** Earning supply is stricter than login/onboarding: only an ACTIVE account may
 * advertise or accept work. The User row lock makes this linearizable with an
 * admin suspension or ban. */
export function assertActiveMoverAccount(status: UserStatus): void {
  if (status !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Your account must be active before you can accept work.');
  }
}

function assertRoleTransitionAccount(status: UserStatus): void {
  // PENDING_VERIFICATION must still be able to finish onboarding. Suspended,
  // banned, and deactivated accounts may not race an authority transition.
  if (status === 'SUSPENDED' || status === 'BANNED' || status === 'DEACTIVATED') {
    throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot switch operating roles.');
  }
}

/** GO is only valid while the account's authoritative surface is a mover. */
export function assertMoverRoleAuthority(
  activeRole: UserRole,
  kind: 'DRIVER' | 'RIDER',
): void {
  const allowed = activeRole === 'MOVER' || activeRole === kind;
  if (!allowed) {
    throw new AppError(
      409,
      'MOVER_ROLE_INACTIVE',
      'Switch to Swift Driver before going online.',
    );
  }
}

/**
 * The profile timestamp is a lightweight authority generation. Any accept,
 * offline, safety, or role-switch write that wins during GO's slower gates
 * invalidates the request. This also closes the switch-away/switch-back (ABA)
 * window without weakening the active-role lock.
 */
export function staleMoverAuthorityError(): AppError {
  return new AppError(
    409,
    'MOVER_AUTHORITY_CHANGED',
    'Your driver status changed while going online. Review it and try again.',
  );
}

/** A unified MOVER account may own both profile rows, but one human cannot be
 * taxi and delivery supply simultaneously. These helpers run after the User
 * authority lock, in the global Rider→Driver profile-lock order. */
export async function lockAndRetireRiderSupply(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; currentOrderId: string | null }>>`
    SELECT "id", "currentOrderId"
    FROM "riders"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;
  const rider = rows[0];
  if (!rider) return null;
  if (rider.currentOrderId) {
    throw new ConflictError('Finish your active delivery before switching to taxi work.');
  }
  await tx.rider.update({
    where: { id: rider.id },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  });
  return rider.id;
}

export async function lockAndRetireDriverSupply(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; currentRideId: string | null }>>`
    SELECT "id", "currentRideId"
    FROM "drivers"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;
  const driver = rows[0];
  if (!driver) return null;
  if (driver.currentRideId) {
    throw new ConflictError('Finish your active taxi ride before switching to delivery work.');
  }
  await tx.driver.update({
    where: { id: driver.id },
    data: { isOnline: false, isAvailable: false, locationSessionId: null },
  });
  return driver.id;
}

/**
 * The single writer for User.activeRole.
 *
 * Leaving mover mode atomically removes idle supply and refuses an active job;
 * entering a role still takes the same User lock as GO. Redis cleanup happens
 * only after PostgreSQL commits, so it can never be the authority decision.
 */
export interface MoverAuthorityCleanup {
  userId: string;
  riderId: string | null;
  driverId: string | null;
  activeRole: UserRole;
  lastMoverRole: MoverRole | null;
}

/** Transaction core, exported so partner provisioning and authority activation
 * can commit as one unit. Callers must run the returned cleanup after commit. */
export async function transitionUserRoleAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  targetRole: UserRole,
): Promise<MoverAuthorityCleanup> {
  const authority = await lockUserRoleAuthority(tx, userId);
  assertRoleTransitionAccount(authority.status);

  // `MOVER` is the public umbrella surface. Resolve it only after acquiring the
  // same User lock that protects lastMoverRole, otherwise a concurrent device
  // can select DRIVER while this request applies a Rider choice read earlier.
  // A damaged legacy pointer degrades to generic onboarding instead of routing
  // into a role/profile the account no longer owns.
  let resolvedTargetRole = targetRole;
  if (
    targetRole === 'MOVER'
    && authority.lastMoverRole
    && authority.roles.includes(authority.lastMoverRole)
  ) {
    const rememberedProfileExists = authority.lastMoverRole === 'RIDER'
      ? await tx.rider.count({ where: { userId } }) === 1
      : await tx.driver.count({ where: { userId } }) === 1;
    if (rememberedProfileExists) resolvedTargetRole = authority.lastMoverRole;
  }

  const leavingMover = resolvedTargetRole === 'CUSTOMER' || resolvedTargetRole === 'VENDOR_OWNER';
  let riderId: string | null = null;
  let driverId: string | null = null;
  if (leavingMover) {
    // Rider then Driver is the global profile-lock order used by authority
    // transitions; GO also takes User first, preventing lock inversion.
    riderId = await lockAndRetireRiderSupply(tx, userId);
    driverId = await lockAndRetireDriverSupply(tx, userId);
  } else if (resolvedTargetRole === 'DRIVER') {
    riderId = await lockAndRetireRiderSupply(tx, userId);
  } else if (resolvedTargetRole === 'RIDER') {
    driverId = await lockAndRetireDriverSupply(tx, userId);
  }
  const lastMoverRole = resolvedTargetRole === 'RIDER' || resolvedTargetRole === 'DRIVER'
    ? resolvedTargetRole
    : authority.lastMoverRole;
  await tx.user.update({
    where: { id: userId },
    data: { activeRole: resolvedTargetRole, lastMoverRole },
  });
  return { userId, riderId, driverId, activeRole: resolvedTargetRole, lastMoverRole };
}

/** Post-commit cleanup for advisory offer/session state. PostgreSQL remains the
 * authority even when Redis is degraded, so every operation is best-effort. */
export async function completeUserRoleAuthorityTransition(
  app: FastifyInstance,
  cleanup: MoverAuthorityCleanup,
): Promise<void> {
  // A connected socket captured its role at handshake time. Drop every live
  // transport after the database commit; reconnecting with the same session is
  // safe because socket auth now resolves the current database activeRole.
  try {
    disconnectUserSockets(app.io, cleanup.userId);
  } catch (error) {
    app.log.warn(
      { err: error, userId: cleanup.userId },
      'role authority socket reconciliation failed',
    );
  }
  if (!cleanup.riderId && !cleanup.driverId) return;
  const dispatch = makeDispatchService(app);
  if (cleanup.riderId) {
    await dispatch
      .releaseHeldOffer(cleanup.riderId)
      .catch((error) => app.log.warn({ err: error, riderId: cleanup.riderId }, 'role authority rider offer cleanup failed'));
    await closeOnlineSession(app.redis, cleanup.riderId)
      .catch((error) => app.log.warn({ err: error, riderId: cleanup.riderId }, 'role authority online-hours close failed'));
  }
  if (cleanup.driverId) {
    await dispatch
      .releaseHeldOffer(cleanup.driverId)
      .catch((error) => app.log.warn({ err: error, driverId: cleanup.driverId }, 'role authority driver offer cleanup failed'));
  }
}

const RIDER_PRE_HANDOFF: readonly OrderStatus[] = [
  'RIDER_ASSIGNED',
  'RIDER_EN_ROUTE_PICKUP',
  'RIDER_ARRIVED_PICKUP',
];
const DRIVER_PRE_HANDOFF: readonly OrderStatus[] = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];
// Terminality has ONE definition [order/order-status.ts]. This module decides
// custody and session revocation; a local copy that drifted from the order
// lifecycle would hold authority over a finished order, or release it on a
// live one.

interface SessionRevocationOrder {
  orderId: string;
  orderNumber: string;
  customerId: string;
  pool: 'RIDER' | 'DRIVER';
  status: OrderStatus;
  action: 'REDISPATCH' | 'ESCALATE';
}

/** Post-commit work produced by a session/security revocation. PostgreSQL owns
 * the authority decision; Redis, sockets, dispatch fan-out, and notifications
 * are deliberately completed only after that transaction commits. */
export interface MoverSessionRevocationCleanup {
  riderId: string | null;
  driverId: string | null;
  orders: SessionRevocationOrder[];
  /** Set by the auth transaction after the authority mutation and its durable
   * customer/custody records have been committed to the outbox. */
  outboxId: string | null;
}

export function emptyMoverSessionRevocationCleanup(): MoverSessionRevocationCleanup {
  return { riderId: null, driverId: null, orders: [], outboxId: null };
}

function resumeDeliveryStatus(order: {
  orderType: string;
  acceptedAt: Date | null;
  preparingAt: Date | null;
  readyAt: Date | null;
}): OrderStatus {
  // Courier parcels are ready at creation. Store orders retain their furthest
  // vendor preparation milestone so replacing a rider never rewinds the
  // kitchen or falsely claims an unfinished order is ready.
  if (order.orderType === 'COURIER' || order.readyAt) return 'READY_FOR_PICKUP';
  if (order.preparingAt) return 'PREPARING';
  return 'ACCEPTED';
}

/** Retire mover authority owned by one auth session (or every session when
 * sessionId is null). The caller MUST already hold the User row lock.
 *
 * Logging out is a security action and may never be refused. The operational
 * policy is therefore stage-aware:
 *   - idle/offer-only supply is removed immediately;
 *   - before physical handoff, the assignment is atomically released and made
 *     dispatchable again;
 *   - after pickup/passenger boarding, the assignment is preserved and paged
 *     to operations immediately. Reassigning goods or a passenger already in
 *     a mover's custody would be materially unsafe.
 */
export async function retireMoverSessionAuthorityInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  sessionId: string | null,
): Promise<MoverSessionRevocationCleanup> {
  const cleanup = emptyMoverSessionRevocationCleanup();
  const ownsGeneration = (
    owner: string | null,
    profile: { isOnline: boolean; isAvailable: boolean },
  ) => sessionId === null
    // Global revocation also heals legacy/null-owner supply that is still
    // advertising online. Once the first revocation has cleared the owner AND
    // forced the profile offline, a repeated logout-all is a true no-op — it
    // must not open a second custody case or send a second customer notice.
    ? owner !== null || profile.isOnline || profile.isAvailable
    : owner === sessionId;

  const riderPreview = await tx.rider.findUnique({ where: { userId }, select: { id: true } });
  if (riderPreview) {
    // [B2 under stacking] Custody is decided on EVERY live leg, not on the
    // primary pointer. Since #899 a rider may hold more than one order, and
    // deciding on `currentOrderId` alone did two wrong things at once: it
    // released the primary and left a stacked sibling assigned to a rider who
    // had just logged out; and when the primary was still pre-pickup it
    // released it "safely" while goods from a SECOND leg were already in the
    // rider's hands, with nobody paged. "Cash in hand on any leg" is the
    // custody question, so every leg is asked.
    //
    // Canonical order -> profile lock order, legs in acceptance order. The
    // User lock held by the caller prevents a new accept from being inserted
    // between the preview and the locks.
    const legPreview = await tx.order.findMany({
      where: { riderId: riderPreview.id, orderType: { not: 'TAXI' }, status: { notIn: TERMINAL_ORDER_STATUSES } },
      select: { id: true },
      orderBy: { acceptedAt: 'asc' },
    });
    for (const leg of legPreview) {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${leg.id} FOR UPDATE`;
    }
    await tx.$queryRaw`SELECT id FROM "riders" WHERE id = ${riderPreview.id} FOR UPDATE`;
    const rider = await tx.rider.findUniqueOrThrow({
      where: { id: riderPreview.id },
      select: { id: true, locationSessionId: true, currentOrderId: true, isOnline: true, isAvailable: true },
    });
    if (ownsGeneration(rider.locationSessionId, rider)) {
      cleanup.riderId = rider.id;
      // Re-read under the locks: a leg may have finished between the preview
      // and the lock, and a finished leg is not a custody question.
      const legs = legPreview.length === 0
        ? []
        : await tx.order.findMany({
            where: { id: { in: legPreview.map((l) => l.id) }, riderId: rider.id, status: { notIn: TERMINAL_ORDER_STATUSES } },
            select: {
              id: true, orderNumber: true, orderType: true, customerId: true, riderId: true, status: true,
              acceptedAt: true, preparingAt: true, readyAt: true, paymentMethod: true, subtotalBase: true,
            },
            orderBy: { acceptedAt: 'asc' },
          });
      for (const order of legs) {
        if (RIDER_PRE_HANDOFF.includes(order.status)) {
          // Goods still at the store: release the assignment and make it
          // dispatchable again — exactly what a rider-cancel would have done.
          const resumed = resumeDeliveryStatus(order);
          await tx.order.update({ where: { id: order.id }, data: { riderId: null, status: resumed } });
          // MONEY stays with the leg it belongs to: this leg's committed CASH
          // float, released with this leg's assignment, in this transaction.
          if (order.paymentMethod === 'CASH') {
            await new FloatService(tx).release(tx, rider.id, Number(order.subtotalBase));
          }
          await tx.orderStatusLog.create({
            data: {
              orderId: order.id,
              status: resumed,
              changedBy: 'system:session-revocation',
              note: 'Mover session ended before pickup — assignment released for re-dispatch',
            },
          });
          cleanup.orders.push({
            orderId: order.id, orderNumber: order.orderNumber, customerId: order.customerId,
            pool: 'RIDER', status: resumed, action: 'REDISPATCH',
          });
        } else {
          // Goods WITH the rider: never reassign — preserve and page.
          cleanup.orders.push({
            orderId: order.id, orderNumber: order.orderNumber, customerId: order.customerId,
            pool: 'RIDER', status: order.status, action: 'ESCALATE',
          });
        }
      }
      // Session and online-ness end here; the pointer and availability are
      // settled by the ONE rule in the seam — the primary re-points to the
      // first leg still held (an in-custody one), else null, and a rider who
      // has just logged out is not free supply whatever the count says.
      await tx.rider.update({ where: { id: rider.id }, data: { locationSessionId: null, isOnline: false } });
      await settleRiderLegs(tx, rider.id, { availability: 'offline' });
    }
  }
  const driverPreview = await tx.driver.findUnique({
    where: { userId },
    select: { id: true, currentRideId: true },
  });
  if (driverPreview?.currentRideId) {
    await lockTaxiOrderForCustodyDecision(tx, driverPreview.currentRideId);
  }
  if (driverPreview) {
    await tx.$queryRaw`SELECT id FROM "drivers" WHERE id = ${driverPreview.id} FOR UPDATE`;
    const driver = await tx.driver.findUniqueOrThrow({
      where: { id: driverPreview.id },
      select: {
        id: true,
        locationSessionId: true,
        currentRideId: true,
        isOnline: true,
        isAvailable: true,
      },
    });
    if (ownsGeneration(driver.locationSessionId, driver)) {
      cleanup.driverId = driver.id;
      const order = driver.currentRideId && driver.currentRideId === driverPreview.currentRideId
        ? await tx.order.findUnique({
            where: { id: driver.currentRideId },
            select: {
              id: true,
              orderNumber: true,
              orderType: true,
              customerId: true,
              driverId: true,
              status: true,
              ridePinVerified: true,
              ridePinVerifiedAt: true,
            },
          })
        : null;

      if (
        order
        && order.orderType === 'TAXI'
        && order.driverId === driver.id
        && DRIVER_PRE_HANDOFF.includes(order.status)
        && !hasTaxiPassengerCustody(order)
      ) {
        await tx.order.update({
          where: { id: order.id },
          // [REPORT-014 F-014-12] Fresh PIN + zeroed attempt budget on every
          // pre-custody release — the revoked driver's knowledge/burn must
          // never bind the replacement's handover window.
          data: { driverId: null, status: 'PENDING', acceptedAt: null, ...freshRidePinReset() },
        });
        await tx.driver.update({
          where: { id: driver.id },
          data: {
            locationSessionId: null,
            isOnline: false,
            isAvailable: false,
            currentRideId: null,
          },
        });
        await tx.orderStatusLog.create({
          data: {
            orderId: order.id,
            status: 'PENDING',
            changedBy: 'system:session-revocation',
            note: 'Driver session ended before pickup — ride released for re-dispatch',
          },
        });
        cleanup.orders.push({
          orderId: order.id,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          pool: 'DRIVER',
          status: 'PENDING',
          action: 'REDISPATCH',
        });
      } else {
        const ownsLiveRide = Boolean(
          order
          && order.orderType === 'TAXI'
          && order.driverId === driver.id
          && !TERMINAL_ORDER_STATUSES.includes(order.status),
        );
        await tx.driver.update({
          where: { id: driver.id },
          data: {
            locationSessionId: null,
            isOnline: false,
            isAvailable: false,
            ...(ownsLiveRide
              ? {}
              : { currentRideId: null }),
          },
        });
        if (
          order
          && order.orderType === 'TAXI'
          && order.driverId === driver.id
          && ownsLiveRide
        ) {
          cleanup.orders.push({
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerId: order.customerId,
            pool: 'DRIVER',
            status: order.status,
            action: 'ESCALATE',
          });
        }
      }
    }
  }

  return cleanup;
}

/** Try the durable post-commit effects immediately for low latency. This call
 * is only an accelerator: a process death or transient dependency failure
 * leaves the PostgreSQL outbox row reclaimable by the recurring worker. */
export async function completeMoverSessionRevocation(
  app: FastifyInstance,
  cleanup: MoverSessionRevocationCleanup,
): Promise<void> {
  if (!cleanup.outboxId) return;
  const dispatch = makeDispatchService(app);
  const delivery = processMoverRevocationOutboxById({
    prisma: app.prisma,
    redis: app.redis,
    io: app.io,
    log: app.log,
    dispatch,
  }, cleanup.outboxId);
  const budgetMs = positiveDurationMs(
    process.env['MOVER_REVOCATION_IMMEDIATE_BUDGET_MS'],
    750,
  );
  try {
    await withTimeout(delivery, budgetMs, 'Immediate mover revocation delivery');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Immediate mover revocation delivery timed out')) {
      // The delivery promise remains observed and continues under its own
      // shorter-than-lease deadline. PostgreSQL is authoritative and the
      // recurring worker will reclaim/retry after any crash or dependency hang.
      app.log.info(
        { outboxId: cleanup.outboxId, budgetMs },
        'mover revocation delivery exceeded request budget; durable retry remains active',
      );
      return;
    }
    throw error;
  }
}

export async function transitionUserRoleAuthority(
  app: FastifyInstance,
  userId: string,
  targetRole: UserRole,
): Promise<{ activeRole: UserRole; lastMoverRole: MoverRole | null }> {
  const cleanup = await app.prisma.$transaction((tx) =>
    transitionUserRoleAuthorityInTransaction(tx, userId, targetRole));
  await completeUserRoleAuthorityTransition(app, cleanup);
  return { activeRole: cleanup.activeRole, lastMoverRole: cleanup.lastMoverRole };
}

/** Linearized admin account-state transition. Suspension/ban refuses an active
 * trip rather than marooning it behind authentication denial, removes all idle
 * supply atomically, and leaves restoration offline until an explicit GO. */
export interface UserStatusTransitionAuditEvidence {
  actorUserId: string;
  reason?: string | null;
  ipAddress?: string;
  userAgent?: string;
}

export async function transitionUserStatusAuthority(
  app: FastifyInstance,
  userId: string,
  targetStatus: 'ACTIVE' | 'SUSPENDED' | 'BANNED',
  auditEvidence?: UserStatusTransitionAuditEvidence,
) {
  const result = await app.prisma.$transaction(async (tx) => {
    const authority = await lockUserRoleAuthority(tx, userId);
    const previousStatus = authority.status;

    if (targetStatus === 'SUSPENDED') {
      if (previousStatus === 'SUSPENDED') {
        throw new AppError(400, 'ALREADY_SUSPENDED', 'User is already suspended');
      }
      if (previousStatus !== 'ACTIVE') {
        throw new AppError(409, 'INVALID_STATUS_TRANSITION', `A ${previousStatus.toLowerCase()} account cannot be suspended`);
      }
    } else if (targetStatus === 'ACTIVE') {
      if (previousStatus !== 'SUSPENDED') {
        throw new AppError(400, 'NOT_SUSPENDED', 'User is not suspended');
      }
    } else if (previousStatus === 'BANNED') {
      throw new AppError(400, 'ALREADY_BANNED', 'User is already banned');
    }

    let cleanup: MoverAuthorityCleanup = {
      userId,
      riderId: null,
      driverId: null,
      activeRole: authority.activeRole,
      lastMoverRole: authority.lastMoverRole,
    };
    if (targetStatus !== 'ACTIVE') {
      try {
        cleanup = {
          userId,
          riderId: await lockAndRetireRiderSupply(tx, userId),
          driverId: await lockAndRetireDriverSupply(tx, userId),
          activeRole: authority.activeRole,
          lastMoverRole: authority.lastMoverRole,
        };
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new AppError(
            409,
            'ACTIVE_JOB',
            'Resolve the active trip or delivery before suspending this account.',
          );
        }
        throw error;
      }
    } else {
      // Defensive legacy cleanup: restoring the account never restores an old
      // supply lease. Both profiles stay offline until the person explicitly
      // taps GO and supplies a fresh coordinate.
      const [rider, driver] = await Promise.all([
        tx.rider.findUnique({ where: { userId }, select: { id: true } }),
        tx.driver.findUnique({ where: { userId }, select: { id: true } }),
      ]);
      if (rider) {
        await tx.rider.update({
          where: { id: rider.id },
          data: { isOnline: false, isAvailable: false, locationSessionId: null },
        });
        cleanup.riderId = rider.id;
      }
      if (driver) {
        await tx.driver.update({
          where: { id: driver.id },
          data: { isOnline: false, isAvailable: false, locationSessionId: null },
        });
        cleanup.driverId = driver.id;
      }
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { status: targetStatus },
    });
    if (targetStatus === 'BANNED') {
      await tx.session.deleteMany({ where: { userId } });
      // A ban is a global security revocation, not merely an API-session
      // deletion. Silence every registered device in the same commit so an
      // already-issued push token cannot keep receiving account/order data.
      await tx.deviceToken.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      });
    }

    if (auditEvidence) {
      const action = targetStatus === 'SUSPENDED'
        ? 'SUSPEND_USER'
        : targetStatus === 'BANNED'
          ? 'BAN_USER'
          : 'UNSUSPEND_USER';
      await tx.auditLog.create({
        data: {
          userId: auditEvidence.actorUserId,
          action,
          entity: 'User',
          entityId: userId,
          changes: {
            previousStatus,
            ...(targetStatus === 'ACTIVE'
              ? {}
              : { reason: auditEvidence.reason ?? null }),
          },
          ipAddress: auditEvidence.ipAddress,
          userAgent: auditEvidence.userAgent,
        },
      });
    }
    return { updated, previousStatus, cleanup };
  });

  // Socket authentication runs only during the initial handshake. Once the
  // status commit makes this account ineligible, evict every live connection
  // before doing advisory mover cleanup; otherwise it can keep receiving user,
  // order, chat, or vendor events until the transport closes naturally.
  if (targetStatus !== 'ACTIVE') {
    try {
      disconnectUserSockets(app.io, userId);
    } catch (error) {
      // PostgreSQL is the account authority. A worker may not have Socket.IO
      // wired, and transport cleanup must never roll back a committed status.
      app.log.warn({ err: error, userId }, 'account status socket cleanup failed');
    }
  }

  await completeUserRoleAuthorityTransition(app, result.cleanup);
  return { updated: result.updated, previousStatus: result.previousStatus };
}
