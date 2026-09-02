import type { PrismaClient, LivenessOutcome, LivenessPurpose } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { getKycProvider, type KycProvider } from '../../providers/kyc/kyc-provider';
import { NotificationService, notifyAdmins, tenantOfUser } from '../notification/notification.service';
import { log } from '../../utils/logger';
import {
  hasTaxiPassengerCustody,
  lockTaxiOrderForCustodyDecision,
} from '../rides/passenger-custody';
import { freshRidePinReset } from '../rides/ride-pin';
import { persistDispatchCommandInTransaction } from '../order/checkout-outbox';
import { notMyDriverCounter, notMyDriverGauge } from '../../plugins/observability';

// Identity Assurance (safety spec §7) — "is the person driving the account's
// approved human?" A fresh shift selfie is face-matched against the signup
// selfie (User.avatar), which the L2/KYC flow already proved against the
// government ID portrait — so the guarantee chain is ID ↔ signup-selfie
// (proven at verification) + signup-selfie ↔ shift-selfie (proven here),
// without decrypting stored documents every shift.
//
// The match rides the SAME swappable KycProvider seam as L2 (hard rule 4).
// Providers return a tri-state, and that tri-state IS the spec's §7.1 ladder:
//   approved        → PASS        (online; cached for the shift)
//   pending_manual  → BORDERLINE  (online, queued for human review)
//   rejected        → FAIL        (retry-capped; 3rd consecutive fail locks)
// Numeric thresholds (0.85/0.70) belong INSIDE adapters — nothing outside the
// provider may know which vendor or score scale exists.
//
// DORMANT until LIVENESS_REQUIRED=1 (same pattern as the other config-gated
// engines): the check endpoint and audit log work everywhere, but go-online
// only enforces freshness once the tenant flips it on.

const livenessRequired = () => process.env['LIVENESS_REQUIRED'] === '1';
const shiftHours = () => {
  const v = Number(process.env['LIVENESS_SHIFT_HOURS']);
  return Number.isFinite(v) && v > 0 ? v : 12;
};
const maxFails = () => {
  const v = Number(process.env['LIVENESS_MAX_FAILS']);
  return Number.isFinite(v) && v > 0 ? v : 3;
};
/** §7.1 — analyzer outage policy. Default FAIL_OPEN_FLAGGED: a vetted driver
 *  locked out of earning by a vendor outage is its own harm; every fail-open
 *  pass is queued for retroactive review and the outage alarms ops. */
const outagePolicy = (): 'FAIL_OPEN_FLAGGED' | 'FAIL_CLOSED' =>
  process.env['LIVENESS_ANALYZER_OUTAGE_POLICY'] === 'FAIL_CLOSED' ? 'FAIL_CLOSED' : 'FAIL_OPEN_FLAGGED';
/** §7.2 — average random mid-shift checks per active mover per week. */
const midshiftPerWeek = () => {
  const v = Number(process.env['LIVENESS_MIDSHIFT_PER_WEEK']);
  return Number.isFinite(v) && v > 0 ? v : 2;
};
/** §7.2 — minutes to answer a mid-shift prompt before being forced offline. */
const midshiftDeadlineMinutes = () => {
  const v = Number(process.env['LIVENESS_MIDSHIFT_DEADLINE_MINUTES']);
  return Number.isFinite(v) && v > 0 ? v : 10;
};

export type MoverProfile = 'DRIVER' | 'RIDER';

/** The go-online gate (§7.1). Pure read of the profile row + env — exported
 *  standalone so the driver/rider routes enforce it without constructing a
 *  service or touching a provider. */
export function assertShiftLiveness(
  row: { lastLivenessPassAt: Date | null; livenessLockedAt: Date | null },
  now = new Date(),
): void {
  // A lock is an explicit safety ACTION (repeated face-match failures or a
  // rider's "this isn't my driver") and holds regardless of the feature flag —
  // LIVENESS_REQUIRED gates the routine freshness cost, never a lock.
  if (row.livenessLockedAt) {
    throw new AppError(423, 'LIVENESS_LOCKED', 'Identity checks failed repeatedly or your identity was disputed — contact support to restore access.');
  }
  if (!livenessRequired()) return;
  const fresh =
    row.lastLivenessPassAt != null &&
    now.getTime() - row.lastLivenessPassAt.getTime() < shiftHours() * 3_600_000;
  if (!fresh) {
    throw new AppError(428, 'LIVENESS_CHECK_REQUIRED', 'Take a quick selfie check to go online.');
  }
}

export interface LivenessCheckResult {
  checkId: string;
  outcome: LivenessOutcome;
  /** Whether this outcome permits going online right now. */
  allowedOnline: boolean;
  /** Remaining attempts before lock — only present after a FAIL. */
  attemptsLeft?: number;
}

/** [S-13 · rollback] Automatic authority mutation (release + lock + dispatch)
 *  is disabled: a report still opens the durable case, which pages a human. */
export const notMyDriverAuthorityKilled = (env: Record<string, string | undefined> = process.env) => env['NOT_MY_DRIVER_AUTHORITY_KILL'] === '1';

export class LivenessService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
    private kyc: KycProvider = getKycProvider(),
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** Run one liveness check and apply its §7.1 consequences. Every check —
   *  pass or fail — is an auditable LivenessCheck row. */
  async check(input: { userId: string; profile: MoverProfile; selfieUrl: string; purpose?: LivenessPurpose }): Promise<LivenessCheckResult> {
    const purpose: LivenessPurpose = input.purpose ?? 'GO_ONLINE';
    const row =
      input.profile === 'DRIVER'
        ? await this.prisma.driver.findUnique({ where: { userId: input.userId }, select: { id: true, livenessLockedAt: true } })
        : await this.prisma.rider.findUnique({ where: { userId: input.userId }, select: { id: true, livenessLockedAt: true } });
    if (!row) throw new NotFoundError(input.profile === 'DRIVER' ? 'Driver' : 'Rider', input.userId);
    if (row.livenessLockedAt) {
      // No point burning provider calls — only ops review clears a lock.
      throw new AppError(423, 'LIVENESS_LOCKED', 'Identity checks failed repeatedly — contact support to restore access.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { avatar: true, selfieCapturedAt: true },
    });
    if (!user?.avatar || !user.selfieCapturedAt) {
      throw new AppError(400, 'SELFIE_REQUIRED', 'Take your profile selfie first — the identity check compares against it.');
    }

    let outcome: LivenessOutcome;
    try {
      const res = await this.kyc.verifyIdentity({
        userId: input.userId,
        idDocumentUrl: user.avatar, // the reference face (already ID-proven at L2)
        selfieUrl: input.selfieUrl,
      });
      outcome = res.status === 'approved' ? 'PASS' : res.status === 'rejected' ? 'FAIL' : 'BORDERLINE';
    } catch (err) {
      outcome = outagePolicy() === 'FAIL_CLOSED' ? 'ERROR_FAIL_CLOSED' : 'ERROR_FAIL_OPEN';
      log().error({ err, userId: input.userId, policy: outagePolicy() }, 'liveness analyzer outage — applying tenant outage policy');
      await notifyAdmins(this.prisma, this.notifications, {
        // Scoped to the person being checked [NOC-A F45].
        tenantId: await tenantOfUser(this.prisma, input.userId),
        title: 'Liveness analyzer outage',
        body: `Face-match provider errored during a ${purpose} check. Policy applied: ${outagePolicy()}. Investigate the provider.`,
        data: { kind: 'liveness_outage', userId: input.userId, policy: outagePolicy() },
      }).catch(() => {});
    }

    const reviewRequired = outcome === 'BORDERLINE' || outcome === 'ERROR_FAIL_OPEN' || purpose === 'RIDER_REPORTED';
    const check = await this.prisma.livenessCheck.create({
      data: { userId: input.userId, profile: input.profile, purpose, selfieUrl: input.selfieUrl, outcome, reviewRequired },
    });

    // §7.1 consequences on the mover profile row. A passing check also
    // answers any pending §7.2 mid-shift prompt.
    const allowedOnline = outcome === 'PASS' || outcome === 'BORDERLINE' || outcome === 'ERROR_FAIL_OPEN';
    const now = new Date();
    if (allowedOnline) {
      const data = { lastLivenessPassAt: now, livenessPromptDeadlineAt: null };
      if (input.profile === 'DRIVER') await this.prisma.driver.update({ where: { id: row.id }, data });
      else await this.prisma.rider.update({ where: { id: row.id }, data });
    }

    if (reviewRequired) {
      const why =
        outcome === 'BORDERLINE'
          ? 'Borderline face-match — compare the shift selfie against the profile side-by-side.'
          : outcome === 'ERROR_FAIL_OPEN'
            ? 'Analyzer outage fail-open — retroactively review this shift selfie.'
            : 'A rider reported "this isn\'t my driver" — review immediately.';
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: await tenantOfUser(this.prisma, input.userId),
        title: 'Liveness review needed',
        body: why,
        data: { kind: 'liveness_review', livenessCheckId: check.id, userId: input.userId, outcome },
      }).catch(() => {});
    }

    let attemptsLeft: number | undefined;
    if (outcome === 'FAIL') {
      // Consecutive fails, newest first, including this one.
      const recent = await this.prisma.livenessCheck.findMany({
        where: { userId: input.userId, profile: input.profile },
        orderBy: { createdAt: 'desc' },
        take: maxFails(),
        select: { outcome: true },
      });
      let consecutive = 0;
      for (const r of recent) {
        if (r.outcome === 'FAIL') consecutive += 1;
        else break;
      }
      attemptsLeft = Math.max(0, maxFails() - consecutive);
      if (consecutive >= maxFails()) {
        // Locked: cannot go online, forced off NOW, ops queue + "contact
        // support" — the account may be shared/sold (the exact abuse §7 exists
        // to stop), so a human decides, never a retry loop.
        const data = { livenessLockedAt: now, isOnline: false, isAvailable: false };
        if (input.profile === 'DRIVER') await this.prisma.driver.update({ where: { id: row.id }, data });
        else await this.prisma.rider.update({ where: { id: row.id }, data });
        await notifyAdmins(this.prisma, this.notifications, {
          tenantId: await tenantOfUser(this.prisma, input.userId),
          title: 'Liveness lock — repeated face-match failures',
          body: `A ${input.profile.toLowerCase()} failed ${consecutive} consecutive identity checks and is locked from going online. Review the check history before clearing.`,
          data: { kind: 'liveness_locked', userId: input.userId, livenessCheckId: check.id },
        }).catch(() => {});
        await this.notifications.send({
          userId: input.userId,
          type: 'SAFETY',
          title: 'Identity check failed',
          body: 'We could not confirm your identity. Contact support to restore access.',
          data: { kind: 'liveness_locked' },
        });
      }
    }

    return { checkId: check.id, outcome, allowedOnline, ...(attemptsLeft !== undefined ? { attemptsLeft } : {}) };
  }

  // ── §7.2 Random mid-shift checks ─────────────────────────────────────────

  /** One tick: enforce expired prompts (missed → forced offline until a fresh
   *  PASS), then randomly select idle online movers for a new prompt at a
   *  probability that averages LIVENESS_MIDSHIFT_PER_WEEK per mover. Never
   *  fires mid-trip (safety tooling must not cause distracted driving; the
   *  idle-between-trips proxy stands in for "vehicle not moving" — there is
   *  no trustworthy speed feed). Post-report/flagged movers get 3× frequency.
   *  Dormant unless LIVENESS_REQUIRED=1. All state is DB columns — the prompt
   *  deadline survives restarts and the enforcement is CAS. */
  async midshiftSweep(now = new Date(), sweepMs = 300_000): Promise<{ prompted: number; enforced: number }> {
    if (!livenessRequired()) return { prompted: 0, enforced: 0 };
    const out = { prompted: 0, enforced: 0 };
    const deadline = new Date(now.getTime() + midshiftDeadlineMinutes() * 60_000);
    const ticksPerWeek = Math.max(1, (7 * 24 * 3_600_000) / sweepMs);
    const baseP = Math.min(1, midshiftPerWeek() / ticksPerWeek);

    const elevated = async (userId: string): Promise<boolean> =>
      (await this.prisma.livenessCheck.count({
        where: {
          userId,
          createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
          OR: [{ purpose: 'RIDER_REPORTED' }, { reviewRequired: true, reviewedAt: null }],
        },
      })) > 0;

    const missedBody = 'You missed the identity check and were taken offline. Take the selfie check in the app to go back online.';
    const promptBody = `Quick identity check: take a selfie in the app within ${midshiftDeadlineMinutes()} minutes to stay online.`;

    // DRIVER side.
    const expiredDrivers = await this.prisma.driver.findMany({
      where: { isOnline: true, livenessPromptDeadlineAt: { lte: now } },
      select: { id: true, userId: true },
      take: 200,
    });
    for (const d of expiredDrivers) {
      const moved = await this.prisma.driver.updateMany({
        where: { id: d.id, isOnline: true, livenessPromptDeadlineAt: { lte: now } },
        data: { isOnline: false, isAvailable: false, lastLivenessPassAt: null, livenessPromptDeadlineAt: null },
      });
      if (moved.count === 1) {
        out.enforced += 1;
        await this.notifications.send({ userId: d.userId, type: 'SAFETY', title: 'Identity check missed', body: missedBody, data: { kind: 'liveness_midshift_missed' } });
      }
    }
    const driverCandidates = await this.prisma.driver.findMany({
      where: { isOnline: true, currentRideId: null, livenessLockedAt: null, livenessPromptDeadlineAt: null },
      select: { id: true, userId: true },
      take: 500,
    });
    for (const c of driverCandidates) {
      let p = baseP;
      if (p < 1 && (await elevated(c.userId))) p = Math.min(1, p * 3);
      if (Math.random() >= p) continue;
      const moved = await this.prisma.driver.updateMany({
        where: { id: c.id, isOnline: true, currentRideId: null, livenessPromptDeadlineAt: null },
        data: { livenessPromptDeadlineAt: deadline },
      });
      if (moved.count === 1) {
        out.prompted += 1;
        await this.notifications.send({ userId: c.userId, type: 'SAFETY', title: 'Safety check-in', body: promptBody, data: { kind: 'liveness_midshift_prompt', respondBy: deadline.toISOString(), profile: 'DRIVER' } });
      }
    }

    // RIDER side (same shape; separate blocks keep the Prisma types honest).
    const expiredRiders = await this.prisma.rider.findMany({
      where: { isOnline: true, livenessPromptDeadlineAt: { lte: now } },
      select: { id: true, userId: true },
      take: 200,
    });
    for (const r of expiredRiders) {
      const moved = await this.prisma.rider.updateMany({
        where: { id: r.id, isOnline: true, livenessPromptDeadlineAt: { lte: now } },
        data: { isOnline: false, isAvailable: false, lastLivenessPassAt: null, livenessPromptDeadlineAt: null },
      });
      if (moved.count === 1) {
        out.enforced += 1;
        await this.notifications.send({ userId: r.userId, type: 'SAFETY', title: 'Identity check missed', body: missedBody, data: { kind: 'liveness_midshift_missed' } });
      }
    }
    const riderCandidates = await this.prisma.rider.findMany({
      where: { isOnline: true, currentOrderId: null, livenessLockedAt: null, livenessPromptDeadlineAt: null },
      select: { id: true, userId: true },
      take: 500,
    });
    for (const c of riderCandidates) {
      let p = baseP;
      if (p < 1 && (await elevated(c.userId))) p = Math.min(1, p * 3);
      if (Math.random() >= p) continue;
      const moved = await this.prisma.rider.updateMany({
        where: { id: c.id, isOnline: true, currentOrderId: null, livenessPromptDeadlineAt: null },
        data: { livenessPromptDeadlineAt: deadline },
      });
      if (moved.count === 1) {
        out.prompted += 1;
        await this.notifications.send({ userId: c.userId, type: 'SAFETY', title: 'Safety check-in', body: promptBody, data: { kind: 'liveness_midshift_prompt', respondBy: deadline.toISOString(), profile: 'RIDER' } });
      }
    }

    return out;
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

    const NOT_ABOARD = ['DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'] as const;
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
