import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService } from '../notification/notification.service';
import { log } from '../../utils/logger';
import {
  hasTaxiPassengerCustody,
  lockTaxiOrderForCustodyDecision,
} from '../rides/passenger-custody';
import { freshRidePinReset } from '../rides/ride-pin';
import { persistDispatchCommandInTransaction } from '../order/checkout-outbox';
import { notMyDriverCounter, notMyDriverGauge } from '../../plugins/observability';
import { DRIVER_PRE_CUSTODY_STATUSES } from '../order/order-status';

// [NO-AI · owner rule 2026-09-07] Identity assurance without a model.
//
// Safety spec §7.1 (a shift selfie compared with the signup selfie) and §7.2 (random
// mid-shift prompts, forced offline on a missed one) were a biometric comparison run by
// the identity provider. That provider is gone and no comparison of faces happens
// anywhere in Swift, so the check, the prompt sweep and every knob that tuned them are
// removed rather than left dormant: a switch that turns on a capability the code no
// longer contains is a lie waiting for an operator to believe it, and boot refuses both
// of the old switches by name (boot-config.ts).
//
// What stays is §7.3: a passenger reporting "this is not my driver" before boarding
// releases the ride, LOCKS the driver account and opens the S1 incident. The lock is a
// human-triggered safety action and holds until ops clears it (incident.service).

/** The go-online gate. A lock is an explicit safety ACTION (a rider's report, or ops)
 *  and is the only identity gate left here. Exported standalone so the driver/rider
 *  routes enforce it without constructing a service. */
export function assertShiftLiveness(row: { livenessLockedAt: Date | null }): void {
  if (row.livenessLockedAt) {
    throw new AppError(423, 'LIVENESS_LOCKED', 'Your identity was disputed on a ride — contact support to restore access.');
  }
}

/** [S-13 · rollback] Automatic authority mutation (release + lock + dispatch)
 *  is disabled: a report still opens the durable case, which pages a human. */
export const notMyDriverAuthorityKilled = (env: Record<string, string | undefined> = process.env) => env['NOT_MY_DRIVER_AUTHORITY_KILL'] === '1';

export class LivenessService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
  ) {
    this.notifications = new NotificationService(prisma, io);
  }
  // ── §7.3 "This isn't my driver" — the account-sharing kill shot ─────────

  /** One tap from the passenger BEFORE boarding: the ride is released back to
   *  dispatch, the driver account is liveness-LOCKED (identity disputed — a
   *  lock holds even with the liveness flag off) and forced offline, ops are
   *  paged at S1 grade. The formal IncidentCase lands with M6; until then the
   *  war-room page + lock + audit trail carry the weight. Aboard-the-vehicle
   *  is SOS territory, not this. */
  /** [S-13] Test seam: runs INSIDE the decision transaction after every write. A throw is the process dying there. Never set in routes. */
  observer: { beforeCommit?: (orderId: string) => Promise<void> } = {};

  async reportNotMyDriver(
    customerUserId: string,
    orderId: string,
    enqueueDispatch?: (orderId: string, jobId: string) => Promise<void>,
  ): Promise<{ reDispatched: boolean; alreadyHandled?: boolean; manualReview?: boolean; sosAvailable: true }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: customerUserId, orderType: 'TAXI' },
      select: {
        id: true,
        status: true,
        orderNumber: true,
        driverId: true,
        ridePinVerified: true,
        ridePinVerifiedAt: true,
        driver: { select: { id: true, userId: true } },
      },
    });
    if (!order) throw new NotFoundError('Ride', orderId);
    if (hasTaxiPassengerCustody(order)) {
      throw new AppError(409, 'RIDE_ALREADY_STARTED', 'If you are in the vehicle and feel unsafe, use the SOS button — help comes faster.');
    }
    if (!order.driverId || !order.driver) {
      // Second tap after the release already happened — honest idempotence.
      if (order.status === 'PENDING') return { reDispatched: true, alreadyHandled: true, sosAvailable: true };
      throw new AppError(409, 'NO_DRIVER_ASSIGNED', 'No driver is assigned to this ride yet.');
    }

    const NOT_ABOARD = DRIVER_PRE_CUSTODY_STATUSES;
    const now = new Date();
    const release = await this.prisma.$transaction(async (tx) => {
      await lockTaxiOrderForCustodyDecision(tx, order.id);
      const current = await tx.order.findFirst({
        where: { id: order.id, customerId: customerUserId, orderType: 'TAXI' },
        select: {
          id: true,
          tenantId: true,
          status: true,
          orderNumber: true,
          driverId: true,
          ridePinVerified: true,
          ridePinVerifiedAt: true,
          driver: { select: { id: true, userId: true } },
        },
      });
      if (!current) throw new NotFoundError('Ride', orderId);
      if (hasTaxiPassengerCustody(current)) {
        throw new AppError(409, 'RIDE_ALREADY_STARTED', 'If you are in the vehicle and feel unsafe, use the SOS button — help comes faster.');
      }
      if (!current.driverId || !current.driver) {
        if (current.status === 'PENDING') return { kind: 'ALREADY_HANDLED' as const };
        throw new AppError(409, 'NO_DRIVER_ASSIGNED', 'No driver is assigned to this ride yet.');
      }
      if (!NOT_ABOARD.includes(current.status as typeof NOT_ABOARD[number])) {
        throw new AppError(409, 'RIDE_STATE_CHANGED', 'The ride changed underneath this report — check its current status.');
      }
      // [S-13] The report is a SAFETY CASE and a DISPATCH COMMAND in the same
      // authority generation as the release and the lock: all four commit
      // together or none does. Notifications come after, and cannot block.
      const { IncidentService } = await import('./incident.service');
      const incidents = new IncidentService(this.prisma, this.io);
      const intake = {
        category: 'IDENTITY_MISMATCH',
        intake: 'SYSTEM_AUTO' as const,
        source: { type: 'LIVENESS_NOT_MY_DRIVER', id: current.id },
        subjectUserId: current.driver.userId,
        reporterUserId: customerUserId,
        orderId: current.id,
        summary: notMyDriverAuthorityKilled()
          ? `Passenger reported "this isn't my driver" on order ${current.orderNumber} before boarding. AUTOMATIC AUTHORITY MUTATION IS DISABLED (rollback): the ride was NOT released and the driver NOT locked — handle this ride manually now.`
          : `Passenger reported "this isn't my driver" on order ${current.orderNumber} before boarding. Driver account liveness-locked and ride re-dispatched.`,
      };
      const staged = await incidents.stageIncidentIntake(tx, intake, incidents.initialSeverityFor(intake), now);
      if (notMyDriverAuthorityKilled()) {
        // Rollback: no automatic release, no lock, no dispatch — the durable
        // case stub pages a human who handles the ride by hand.
        await tx.orderStatusLog.create({
          data: { orderId: current.id, status: current.status, changedBy: 'system:not-my-driver', note: 'Passenger reported "this isn\'t my driver" — automatic authority mutation disabled (rollback); case opened for manual handling' },
        });
        await this.observer.beforeCommit?.(current.id);
        return { kind: 'MANUAL' as const, order: { id: current.id, orderNumber: current.orderNumber }, driverUserId: current.driver.userId, staged, intake, dispatchJobId: null };
      }
      await tx.order.update({
        where: { id: current.id },
        // [REPORT-014 F-014-12] Fresh PIN + zeroed attempt budget: the flagged
        // driver's knowledge/burn must never bind the replacement's window.
        data: { status: 'PENDING', driverId: null, acceptedAt: null, ...freshRidePinReset() },
      });
      await tx.driver.updateMany({
        where: { id: current.driverId },
        data: { isOnline: false, isAvailable: false, currentRideId: null, livenessLockedAt: now, lastLivenessPassAt: null },
      });
      await tx.orderStatusLog.create({
        data: { orderId: current.id, status: 'PENDING', changedBy: 'system:not-my-driver', note: 'Passenger reported "this isn\'t my driver" — ride released and re-dispatched; driver locked pending identity review' },
      });
      const command = await persistDispatchCommandInTransaction(tx, { orderId: current.id, tenantId: current.tenantId, reason: 'not-my-driver', now });
      await this.observer.beforeCommit?.(current.id);
      return {
        kind: 'RELEASED' as const,
        order: { id: current.id, orderNumber: current.orderNumber },
        driverUserId: current.driver.userId,
        staged,
        intake,
        dispatchJobId: command.id,
      };
    });
    if (release.kind === 'ALREADY_HANDLED') {
      return { reDispatched: true, alreadyHandled: true, sosAvailable: true };
    }
    const releasedOrder = release.order;
    notMyDriverCounter.labels(release.kind === 'MANUAL' ? 'manual_review' : 'released').inc();
    // Everything from here is best-effort and independent: the case exists,
    // the ride is released (or the manual case is open), the command is durable.
    const { IncidentService } = await import('./incident.service');
    await new IncidentService(this.prisma, this.io).afterIntakeCommitted(release.staged, release.intake)
      .catch((err) => log().error({ err, orderId: releasedOrder.id }, 'not-my-driver: post-commit incident effects failed — the case already exists'));
    if (release.kind === 'MANUAL') {
      return { reDispatched: false, manualReview: true, sosAvailable: true };
    }
    try {
      this.io.to(`order:${releasedOrder.id}`).emit('order:status_changed', { orderId: releasedOrder.id, status: 'PENDING', reason: 'not_my_driver' });
      this.io.to('ops:war-room').emit('safety:not-my-driver', { orderId: releasedOrder.id, driverUserId: release.driverUserId, at: now.toISOString() });
    } catch { /* advisory only */ }
    await this.notifications.send({
      userId: customerUserId,
      type: 'ORDER_UPDATE',
      title: 'Finding you another driver',
      body: 'Do not enter the vehicle. We are matching you with the nearest available driver now.',
      data: { orderId: releasedOrder.id, status: 'PENDING' },
    }).catch((err) => log().error({ err, orderId: releasedOrder.id }, 'not-my-driver: passenger notification failed — redispatch is durable regardless'));
    // The inline fast path publishes the SAME job the outbox drainer would
    // (deterministic jobId); on success the command is marked done so the
    // drainer does not publish it twice. If this dies, the drainer does it.
    if (enqueueDispatch && release.dispatchJobId) {
      try {
        await enqueueDispatch(releasedOrder.id, release.dispatchJobId);
        await this.prisma.orderOutbox.updateMany({ where: { id: release.dispatchJobId, processedAt: null }, data: { processedAt: new Date() } });
      } catch (err) {
        log().warn({ err, orderId: releasedOrder.id }, 'not-my-driver: inline dispatch enqueue failed — the outbox drainer will publish it');
      }
    }
    return { reDispatched: true, sosAvailable: true };
  }
}

/** [S-13 · operations] Every not-my-driver decision must own its case and its
 *  dispatch command. Decisions lacking either are named, repaired (the missing
 *  artifact is staged — never a second release), and paged. */
export async function scanNotMyDriverDecisions(prisma: PrismaClient, now = new Date()): Promise<{ missingCase: string[]; missingDispatch: string[] }> {
  const { intakeFingerprint } = await import('./incident.service');
  const { dispatchCommandDedupeKey } = await import('../order/checkout-outbox');
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const decisions = await prisma.orderStatusLog.findMany({ where: { changedBy: 'system:not-my-driver', status: 'PENDING', createdAt: { gte: since } }, select: { orderId: true }, distinct: ['orderId'], take: 500 });
  const missingCase: string[] = []; const missingDispatch: string[] = [];
  for (const d of decisions) {
    const kase = await prisma.incidentCase.findUnique({ where: { sourceFingerprint: intakeFingerprint({ type: 'LIVENESS_NOT_MY_DRIVER', id: d.orderId }) }, select: { id: true } });
    if (!kase) missingCase.push(d.orderId);
    const cmd = await prisma.orderOutbox.findUnique({ where: { dedupeKey: dispatchCommandDedupeKey(d.orderId, 'not-my-driver') }, select: { id: true } });
    if (!cmd) missingDispatch.push(d.orderId);
  }
  notMyDriverGauge.labels('missing_case').set(missingCase.length);
  notMyDriverGauge.labels('missing_dispatch').set(missingDispatch.length);
  return { missingCase, missingDispatch };
}

export async function repairNotMyDriverDecisions(prisma: PrismaClient, io: Server, now = new Date()): Promise<{ repaired: string[] }> {
  const scan = await scanNotMyDriverDecisions(prisma, now);
  const { IncidentService } = await import('./incident.service');
  const { persistDispatchCommandInTransaction } = await import('../order/checkout-outbox');
  const repaired: string[] = [];
  for (const orderId of new Set([...scan.missingCase, ...scan.missingDispatch])) {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, tenantId: true, orderNumber: true, status: true, customerId: true } });
    if (!order) continue;
    const log = await prisma.orderStatusLog.findFirst({ where: { orderId, changedBy: 'system:not-my-driver' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    // the driver the decision removed is not on the order any more: the case names the order; ops attribute the subject from the log
    const incidents = new IncidentService(prisma, io);
    await prisma.$transaction(async (tx) => {
      if (scan.missingCase.includes(orderId)) {
        const intake = { category: 'IDENTITY_MISMATCH', intake: 'SYSTEM_AUTO' as const, source: { type: 'LIVENESS_NOT_MY_DRIVER', id: orderId }, subjectUserId: order.customerId, reporterUserId: order.customerId, orderId, summary: `REPAIRED (S-13 scan): a not-my-driver decision on order ${order.orderNumber} at ${log?.createdAt.toISOString() ?? 'unknown'} had no case. Subject must be attributed by ops from the status log.` };
        const staged = await incidents.stageIncidentIntake(tx, intake, 'S1', now);
        await incidents.afterIntakeCommitted(staged, intake).catch(() => null);
      }
      if (scan.missingDispatch.includes(orderId) && order.status === 'PENDING') {
        await persistDispatchCommandInTransaction(tx, { orderId, tenantId: order.tenantId, reason: 'not-my-driver', now });
      }
    });
    repaired.push(orderId); notMyDriverCounter.labels('repaired').inc();
  }
  return { repaired };
}
