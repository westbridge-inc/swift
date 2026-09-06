import type { OnAudit } from '../../lib/audit-writer';
import type { Prisma, PrismaClient, ReimbursementClaim } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { assertClaimAmountAttested, isDuplicateReferenceError, normaliseClaimPaymentRef } from './claim-payout';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';
import { OrderService, assertMmgFulfilmentAllowed } from '../order/order.service';
import { FloatService } from '../dispatch/float.service';
import { haversineDistance } from '../../utils/distance';
import { clusterMemberIds } from '../integrity/identity.service';
import { noShowDecision, type ArrivalFix } from '../order/cancel-policy';
import {
  LOSS_PROTECTION_DEFAULTS, LOSS_PROTECTION_FLAGS, adjustReserve, assembleClaimEvidence, assertEvidenceComplete, coveredAmountFor,
  drawReserveForPayout, reserveStatement, rollingClaimTotal, type LossProtectionRules,
} from './rlp';

// ---------------------------------------------------------------------------
// Cash rules engine — the golden rule as code. Payment
// happens before handover; a failed handover under the USD gate becomes a
// company-guaranteed claim with GPS evidence, the customer takes a strike,
// and deterministic guardrails (caps, outliers, collusion patterns) route
// suspicious claims to manual review instead of auto-payout. Rider trust
// depends on this; no AI ever decides a money outcome.
// ---------------------------------------------------------------------------

export interface CashRulesConfig extends LossProtectionRules {
  maxClaimsPerRiderPerMonth: number;
  strikeRestrictThreshold: number;
  strikeBanThreshold: number;
  l3MinPaidOrders: number;
  l3MinAccountAgeDays: number;
  outlierMultiplier: number;
  /** SWIFT-076: a guarantee claim whose handover GPS is farther than this from
   *  the order's delivery point can't be trusted to auto-pay — it's flagged for
   *  review. Generous enough for GPS drift + a large compound; tight enough to
   *  catch a claim fabricated from across town. Overridable per CountryConfig. */
  maxHandoverDistanceKm: number;
}

export const DEFAULT_CASH_RULES: CashRulesConfig = {
  // [DOC-1 §31.4 · P31-1] The loss-protection policy tunables, relative to the ID gate.
  ...LOSS_PROTECTION_DEFAULTS,
  maxClaimsPerRiderPerMonth: 3,
  strikeRestrictThreshold: 2,
  strikeBanThreshold: 4,
  l3MinPaidOrders: 20,
  l3MinAccountAgeDays: 30,
  outlierMultiplier: 3,
  maxHandoverDistanceKm: 0.75,
};

/**
 * The country's cash rules: the code defaults under the stored overrides.
 * Exported so a reader elsewhere (ALG-30 reuses `maxHandoverDistanceKm` as
 * the drop radius) imports THIS merge rather than re-expressing it.
 */
export async function cashRulesFor(countryConfig: CountryConfigService, countryCode: string): Promise<CashRulesConfig> {
  const config = await countryConfig.getByCode(countryCode);
  return { ...DEFAULT_CASH_RULES, ...((config.cashRules as Partial<CashRulesConfig> | null) ?? {}) };
}

/**
 * THE evidence format: `gps:LAT,LNG` at 5 decimal places (~1 m), written into
 * the immutable status-log note.
 *
 * This file is its ONE author, and `kerb-anti-fork.test.ts` K3 enforces that by
 * name — one appeal view must be able to read deliveries, rides and arrivals
 * through the same lens, and a second `gps:${...}` template anywhere is how two
 * lenses start. Anything else that records a position imports this.
 *
 * (It caught a second author being added for arrival evidence, which is exactly
 * what it is for.)
 */
export const gpsEvidence = (lat: number, lng: number): string =>
  `gps:${lat.toFixed(5)},${lng.toFixed(5)}`;

/**
 * Handover is only legal at the door — or, for a ride, at the destination with
 * the passenger aboard [M-29]. Exported so the order state machine's FAILED
 * predecessor list stays in lockstep with this guard (SWIFT-096): a failed
 * cash handover is the ONLY way an order reaches FAILED, and it can only be
 * recorded from these states. Widening one without the other would let the
 * machine permit a transition the service can never produce.
 */
export const HANDOVER_STATES = ['ARRIVED', 'RIDE_IN_PROGRESS', 'PICKED_UP', 'EN_ROUTE_DELIVERY'] as const; // [M-28] a courier's recipient outcome: the parcel in custody

/** [M-28] A courier job's cash outcome is recorded with the parcel in custody
 *  — wherever the rider physically hands it over. */
export const COURIER_CUSTODY_STATES = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'] as const;

/** [M-29] The instant the fare outcome became mandatory for cash rides. A
 *  cash TAXI order delivered after it with no captured fare is a defect (the
 *  terminal authority refuses the transition); one delivered before it is
 *  legacy — the manual-review set the reconciler reports and never mints for. */
export const TAXI_FARE_OUTCOME_ENFORCED_AT = new Date('2026-09-02T03:00:00.000Z');
/** [M-28] The instant the cash outcome became mandatory for cash courier jobs. */
export const COURIER_CASH_OUTCOME_ENFORCED_AT = new Date('2026-09-02T09:00:00.000Z');

/** The mover a guarantee claim belongs to: exactly one of the two (the
 *  database checks it). A delivery's claim names the rider, a ride's the driver. */
export type ClaimMover = { riderId: string; driverId: null } | { riderId: null; driverId: string };

/** A ride's duration in minutes for the completion record, as the completion
 *  tap always computed it. */
function rideDurationMinutes(order: { pickedUpAt: Date | null; taxiDuration: number | null }): number | null {
  return order.pickedUpAt ? Math.round((Date.now() - order.pickedUpAt.getTime()) / 60_000) : order.taxiDuration;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Strike consequences at placement, free of service cycles so checkout and
 * ride-request can import it directly: restricted -> verified-only (L2+),
 * banned -> no ordering at all. Thresholds come from CountryConfig.
 */
export async function orderingRestriction(
  prisma: PrismaClient,
  userId: string,
): Promise<'restricted' | 'banned' | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { countryCode: true, trustLevel: true },
  });
  if (!user) return null;

  const config = await prisma.countryConfig.findUnique({ where: { code: user.countryCode } });
  const rules = { ...DEFAULT_CASH_RULES, ...((config?.cashRules as Partial<CashRulesConfig> | null) ?? {}) };

  // Trial-integrity A6: strikes follow the HUMAN, not the account — a COD
  // no-pay history rides the identity cluster, so a fresh account starts
  // with the cluster's live strikes (same 90-day aging; the trust ladder
  // still lets them rebuild — the graph removes the shortcut, not the path).
  // No cluster → exactly the old per-user check.
  const member = await prisma.identityClusterMember.findUnique({ where: { accountId: userId }, select: { clusterId: true } });
  let strikeUserIds = [userId];
  if (member) {
    let root = member.clusterId;
    for (let hops = 0; hops < 32; hops += 1) {
      const c = await prisma.identityCluster.findUnique({ where: { id: root }, select: { mergedIntoId: true } });
      if (!c?.mergedIntoId) break;
      root = c.mergedIntoId;
    }
    const members = await prisma.identityClusterMember.findMany({ where: { clusterId: root }, select: { accountId: true } });
    if (members.length > 1) strikeUserIds = members.map((m) => m.accountId);
  }

  const strikes = await prisma.strike.count({
    where: { userId: { in: strikeUserIds }, createdAt: { gte: new Date(Date.now() - 90 * DAY_MS) } },
  });

  if (strikes >= rules.strikeBanThreshold) return 'banned';
  if (strikes >= rules.strikeRestrictThreshold && user.trustLevel === 'L1') return 'restricted';
  return null;
}

/** The trust badge a mover sees before fronting cash for a customer (§4d):
 *  trust level, completed-order count, strikes in the last 90 days, tenure.
 *  Batch-shaped (3 queries total, whatever the list size) — never per-row. */
export async function customerTrustSummaries(
  prisma: PrismaClient,
  userIds: string[],
): Promise<Map<string, { trustLevel: string; completedOrders: number; strikes: number; memberSince: Date }>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Map();

  const [users, strikes, completed] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, trustLevel: true, createdAt: true } }),
    prisma.strike.groupBy({
      by: ['userId'],
      where: { userId: { in: ids }, createdAt: { gte: new Date(Date.now() - 90 * DAY_MS) } },
      _count: true,
    }),
    prisma.order.groupBy({
      by: ['customerId'],
      where: { customerId: { in: ids }, status: { in: ['DELIVERED', 'COMPLETED'] } },
      _count: true,
    }),
  ]);

  const strikeMap = new Map(strikes.map((s) => [s.userId, s._count]));
  const orderMap = new Map(completed.map((o) => [o.customerId, o._count]));
  return new Map(
    users.map((u) => [
      u.id,
      {
        trustLevel: u.trustLevel,
        completedOrders: orderMap.get(u.id) ?? 0,
        strikes: strikeMap.get(u.id) ?? 0,
        memberSince: u.createdAt,
      },
    ]),
  );
}

/** [M-24] A seam for the atomicity proofs: called INSIDE the handover's
 *  transaction after every terminal fact is staged and before the commit, so
 *  a thrown error rolls the whole generation back exactly as a crash would. */
export interface CashHandoverObserver {
  afterTerminalFacts?: (stage: 'paid' | 'failed') => Promise<void>;
}
type EarningNotices = Awaited<ReturnType<OrderService['createEarnings']>>;
type StagedClaim = {
  claim: ReimbursementClaim | null;
  riderNotice: { userId: string; type: 'SYSTEM_ANNOUNCEMENT'; title: string; body: string; data: Record<string, unknown> } | null;
};

export class CashRulesService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private orders: OrderService,
    /** [M-24] Test seam only — see CashHandoverObserver. Production passes nothing. */
    private readonly observer: CashHandoverObserver = {},
  ) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  async configFor(countryCode: string): Promise<CashRulesConfig> {
    return cashRulesFor(this.countryConfig, countryCode);
  }

  // -------------------------------------------------------------------------
  // The handover — golden rule enforcement point
  // -------------------------------------------------------------------------

  async handover(
    orderId: string,
    moverUserId: string,
    input: { outcome: 'paid' | 'no_show' | 'refused'; gps: { lat: number; lng: number }; photoUrl?: string; courierProofPhotoUrl?: string },
  ) {
    // [M-29] The mover is a rider (a delivery at the door) or a driver (a ride
    // at the destination): one rail, one golden rule, one claim shape. A user
    // may hold both profiles, so the order decides which one is acting.
    const MOVER_POSITION = { id: true, currentLat: true, currentLng: true, lastLocationUpdate: true } as const;
    const [rider, driver] = await Promise.all([
      this.prisma.rider.findUnique({ where: { userId: moverUserId }, select: MOVER_POSITION }),
      this.prisma.driver.findUnique({ where: { userId: moverUserId }, select: MOVER_POSITION }),
    ]);
    if (!rider && !driver) throw new NotFoundError('Rider');

    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        OR: [
          ...(rider ? [{ riderId: rider.id }] : []),
          ...(driver ? [{ driverId: driver.id }] : []),
        ],
      },
      include: { customer: { select: { id: true, phone: true, countryCode: true, trustLevel: true, createdAt: true } } },
    });
    if (!order) throw new NotFoundError('Order', orderId);
    const mover: ClaimMover | null = rider && order.riderId === rider.id
      ? { riderId: rider.id, driverId: null }
      : driver && order.driverId === driver.id
        ? { riderId: null, driverId: driver.id }
        : null;
    if (!mover) throw new NotFoundError('Order', orderId);
    const isRide = order.orderType === 'TAXI';
    // [M-28] A courier job whose recipient pays: the outcome is recorded with
    // the proof, with the parcel in custody. The proof photo is the claim's
    // evidence when the recipient did not pay.
    const isCourier = order.orderType === 'COURIER';

    // [SPS-F-0016 / REPORT-004 F-004-02] Ownership stays first (404 above).
    // This endpoint is the CASH golden-rule enforcement point and nothing
    // else: a mover must never self-attest an MMG payment (only the store's
    // confirm-payment may capture MMG), and the failure branch must never
    // strike a customer or mint a company-guarantee ReimbursementClaim for a
    // rail this endpoint does not govern. Pending MMG paid-at-door gets the
    // package's one payment-pending error; any other non-cash use is simply
    // the wrong endpoint.
    if (input.outcome === 'paid') assertMmgFulfilmentAllowed(order, 'DELIVERED');
    if (order.paymentMethod !== 'CASH') {
      throw new AppError(409, 'CASH_HANDOVER_ONLY', 'Customer cash handover is available only for cash orders.');
    }

    // [M-24] A terminal retry of the mover's own finished handover (a lost
    // response, a double tap) answers the coherent facts it already wrote
    // instead of refusing — every fact committed together, so there is no
    // partial state to complete.
    if (order.status === 'DELIVERED' && input.outcome === 'paid' && order.paymentStatus === 'CAPTURED') {
      return { order, claim: null };
    }
    if (order.status === 'FAILED' && input.outcome !== 'paid') {
      const claim = await this.prisma.reimbursementClaim.findFirst({ where: { orderId } });
      return { order, claim };
    }
    // A delivery is handed over at the door (ARRIVED); a ride's fare is settled
    // at the destination with the passenger aboard (RIDE_IN_PROGRESS); a
    // courier's fee is settled with the parcel in custody.
    const handoverStates: readonly string[] = isRide ? ['RIDE_IN_PROGRESS'] : isCourier ? COURIER_CUSTODY_STATES : ['ARRIVED'];
    if (!handoverStates.includes(order.status)) {
      throw new AppError(409, 'NOT_AT_DOOR', isRide
        ? `The fare outcome is only available at the destination with the passenger aboard (ride is ${order.status})`
        : isCourier
          ? `The cash outcome is only available with the parcel in custody (job is ${order.status})`
          : `Handover is only available at the delivery point (order is ${order.status})`);
    }

    const gpsNote = gpsEvidence(input.gps.lat, input.gps.lng);
    if (input.outcome === 'paid') {
      // [M-24] ONE terminal generation: the captured payment, the DELIVERED
      // transition and the earnings commit together on the canonical seam's
      // transaction. Before, CAPTURED was written first and DELIVERED and the
      // earnings followed as separate statements, so a failure between them
      // left "captured but not delivered" or "delivered but never paid out".
      let earningNotices: EarningNotices = [];
      const withinTransaction = async (tx: Prisma.TransactionClient) => {
        await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'CAPTURED' } });
        // The seam mints a delivery's earnings itself; this call is a no-op
        // when it already did and the minting call when the capture above
        // was what the earnings were waiting for (every cash ride). Either
        // way: inside the tx.
        earningNotices = await this.orders.createEarnings(orderId, tx, false);
        await this.observer.afterTerminalFacts?.('paid');
      };
      const updated = isRide
        // [M-29] A ride's completion IS its fare outcome: the terminal facts
        // the completion tap used to write alone (actual duration, driver
        // release and rate rehabilitation) now commit with the captured fare.
        ? (await this.orders.transitionOrderAtomically({
            orderId,
            target: 'DELIVERED',
            allowedFrom: ['RIDE_IN_PROGRESS'],
            changedBy: moverUserId,
            note: `fare collected — ${gpsNote}`,
            terminalMetadata: { actualDeliveryTime: rideDurationMinutes(order) },
            decayDriverCancellationRate: true,
            withinTransaction,
            invalidStatus: (current) => new AppError(409, 'INVALID_STATUS', `Cannot complete ride from status ${current}`),
          })).order
        : isCourier
          // [M-28] A courier job completes with its proof AND its money: the
          // captured fee, the proof photo, DELIVERED and the earnings, one commit.
          ? (await this.orders.transitionOrderAtomically({
              orderId,
              target: 'DELIVERED',
              allowedFrom: COURIER_CUSTODY_STATES,
              expectedRiderId: mover.riderId ?? undefined,
              changedBy: moverUserId,
              note: `payment collected — ${gpsNote}`,
              ...(input.courierProofPhotoUrl ? { terminalMetadata: { courierProofPhotoUrl: input.courierProofPhotoUrl } } : {}),
              withinTransaction,
              invalidStatus: (current) => new AppError(409, 'NOT_IN_TRANSIT', `Cannot close a courier job from status ${current}`),
            })).order
          : await this.orders.updateStatus(orderId, 'DELIVERED', moverUserId, `payment collected — ${gpsNote}`, { withinTransaction });
      for (const notice of earningNotices) {
        await this.notifications.earningAvailable(notice.userId, notice.amount, notice.type).catch(() => {});
      }
      await this.maybePromoteToL3(order.customer.id, order.customer.countryCode).catch(() => {});
      return { order: updated, claim: null };
    }
    // [M-24] ONE terminal generation for a failed handover: FAILED, the
    // payment status, the customer's strike and the mover's guarantee claim
    // commit together on the seam's transaction. Before, they were four
    // separate statements with a notification in the middle — a failure at
    // the notification left the order FAILED and the customer struck with no
    // claim for the mover, and the terminal retry was refused.
    const addressKey = `geo:${order.deliveryLat.toFixed(4)}:${order.deliveryLng.toFixed(4)}`;

    // [AF-MOB-001] A no-show may not be instant, and weak evidence may not
    // punish. Scoped to the delivery rail's no-show: a `refused` customer was
    // demonstrably present, and a taxi fare settles with the passenger aboard.
    let strikeCustomer = true;
    let noShowNote = '';
    if (input.outcome === 'no_show' && !isRide && !isCourier) {
      const arrival = await this.prisma.orderStatusLog.findFirst({
        where: { orderId, status: 'ARRIVED' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const mover2 = rider ?? driver;
      const now = new Date();
      const fix: ArrivalFix = mover2?.currentLat != null && mover2.currentLng != null && mover2.lastLocationUpdate
        ? {
            metres: Math.round(haversineDistance(mover2.currentLat, mover2.currentLng, order.deliveryLat, order.deliveryLng) * 1000),
            ageMs: now.getTime() - mover2.lastLocationUpdate.getTime(),
          }
        : { metres: null, ageMs: null };
      const decision = noShowDecision({ arrivedAt: arrival?.createdAt ?? null, fix }, now);
      if (!decision.allowed) {
        // Refuses EARLINESS, never the outcome — and says when to try again.
        // Band F: a mover must never be stranded, only asked to wait.
        throw decision.reason === 'NOT_ARRIVED'
          ? new AppError(409, 'NO_SHOW_NOT_ARRIVED', 'Mark that you have arrived before reporting a no-show.')
          : new AppError(409, 'NO_SHOW_TOO_EARLY', `Wait until ${decision.retryAt.toISOString()} before reporting a no-show — the customer still has time to come to the door.`);
      }
      strikeCustomer = decision.strikeCustomer;
      noShowNote = ` evidence:${decision.evidence}${strikeCustomer ? '' : ' strike:withheld-for-review'}`;
    }

    let staged: StagedClaim = { claim: null, riderNotice: null };
    const failed = await this.orders.updateStatus(
      orderId,
      'FAILED',
      moverUserId,
      `${input.outcome} — ${gpsNote}${input.photoUrl ? ' photo:yes' : ''}${noShowNote}`,
      {
        withinTransaction: async (tx) => {
          await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'FAILED' } });
          // [AF-MOB-001] The MOVER is always made whole (stageClaim below);
          // the CUSTOMER's strike waits for evidence that supports it. A
          // punishment on a stale or distant fix is a wrong punishment, and
          // unlike a missing payout it cannot be noticed and corrected later.
          if (strikeCustomer) {
            await tx.strike.create({
              data: {
                userId: order.customer.id,
                orderId,
                reason: `failed_payment_${input.outcome}`,
                phone: order.customer.phone,
                addressKey,
              },
            });
          }
          staged = await this.stageClaim(tx, order, mover, input, addressKey);
          await this.observer.afterTerminalFacts?.('failed');
        },
      },
    );
    // Notices leave AFTER the money committed — never inside it, never before
    // the claim. A lost notice is a lost notice, not a lost claim.
    await this.notifications.send({
      userId: order.customer.id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: isRide ? 'Unpaid fare recorded' : isCourier ? 'Unpaid courier fee recorded' : 'Failed delivery recorded',
      body: isRide
        ? 'Your ride’s fare was not paid at the destination. Repeated incidents restrict your account.'
        : isCourier
          ? 'The courier fee was not paid at the drop-off. Repeated incidents restrict your account.'
          : 'Your order was not paid for at the door. Repeated incidents restrict your account.',
      data: { kind: 'strike', orderId },
    }).catch(() => {});
    if (staged.riderNotice) await this.notifications.send(staged.riderNotice).catch(() => {});
    return { order: failed, claim: staged.claim };
  }

  /** [M-28] A courier job whose SENDER pays: the fee is collected before the
   *  parcel is carried. 'paid' captures it (the status does not move — the
   *  proof still completes the job later); 'refused' ends the job before
   *  custody, with a strike on the sender and no guarantee claim — nothing
   *  was carried, so nothing is owed to the rider by the guarantee. */
  async collectFromSender(
    orderId: string,
    riderUserId: string,
    input: { outcome: 'paid' | 'refused'; gps: { lat: number; lng: number } },
  ) {
    const rider = await this.prisma.rider.findUnique({ where: { userId: riderUserId }, select: { id: true } });
    if (!rider) throw new NotFoundError('Rider');
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, riderId: rider.id, orderType: 'COURIER' },
      include: { customer: { select: { id: true, phone: true } } },
    });
    if (!order) throw new NotFoundError('CourierOrder', orderId);
    if (order.paymentMethod !== 'CASH') throw new AppError(409, 'CASH_HANDOVER_ONLY', 'Collecting from the sender is a cash step.');
    if (order.courierPayer !== 'SENDER') throw new AppError(409, 'RECIPIENT_PAYS', 'The recipient pays for this job — record the outcome with the proof at the drop-off.');
    const gpsNote = gpsEvidence(input.gps.lat, input.gps.lng);
    if (input.outcome === 'paid') {
      if (order.paymentStatus === 'CAPTURED') return { order, collected: true as const }; // a repeated tap answers the fact
      const before: readonly string[] = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'PICKED_UP'];
      if (!before.includes(order.status)) throw new AppError(409, 'NOT_AT_PICKUP', `The sender's fee is collected at pickup (job is ${order.status})`);
      const updated = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.order.updateMany({ where: { id: orderId, riderId: rider.id, paymentStatus: { not: 'CAPTURED' } }, data: { paymentStatus: 'CAPTURED' } });
        if (claimed.count !== 1) throw new AppError(409, 'ALREADY_COLLECTED', 'The fee was already recorded as collected.');
        await tx.orderStatusLog.create({ data: { orderId, status: order.status, note: `cash collected from sender — ${gpsNote}` } });
        return tx.order.findUniqueOrThrow({ where: { id: orderId } });
      });
      return { order: updated, collected: true as const };
    }
    // Refused before custody: the job ends here, the sender takes a strike.
    if (order.status === 'CANCELLED') return { order, collected: false as const };
    const addressKey = `geo:${order.pickupLat?.toFixed(4) ?? '0'}:${order.pickupLng?.toFixed(4) ?? '0'}`;
    const cancelled = await this.orders.updateStatus(orderId, 'CANCELLED', riderUserId, `sender refused to pay — ${gpsNote}`, {
      withinTransaction: async (tx) => {
        await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'FAILED' } });
        await tx.strike.create({ data: { userId: order.customer.id, orderId, reason: 'failed_payment_refused', phone: order.customer.phone, addressKey } });
        await this.observer.afterTerminalFacts?.('failed');
      },
    });
    await this.notifications.send({
      userId: order.customer.id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Courier job ended — fee not paid',
      body: 'The courier fee was not paid at pickup, so the job was cancelled. Repeated incidents restrict your account.',
      data: { kind: 'strike', orderId },
    }).catch(() => {});
    return { order: cancelled, collected: false as const };
  }

  // -------------------------------------------------------------------------
  // Claims + guardrails
  // -------------------------------------------------------------------------

  /** [M-24] The guarantee claim, staged on the handover's transaction. The
   *  rider's notice is returned, not sent — the caller sends it after the
   *  commit. */
  private async stageClaim(
    tx: Prisma.TransactionClient,
    order: {
      id: string;
      orderType: string;
      subtotalBase: unknown;
      totalAmount: unknown;
      deliveryLat: number | null;
      deliveryLng: number | null;
      customer: { id: string; phone: string; countryCode: string };
    },
    mover: ClaimMover,
    input: { outcome: 'paid' | 'no_show' | 'refused'; gps: { lat: number; lng: number }; photoUrl?: string; courierProofPhotoUrl?: string },
    addressKey: string,
  ): Promise<StagedClaim> {
    // [DOC-1 §31.3/§31.4 · P31-1] The policy covers what the rider FRONTED — the food
    // cost on a delivery, never the delivery fee — and the cap per claim is the ID gate,
    // measured on that same figure: above it the ID is on file instead.
    const amount = coveredAmountFor(order);
    const moverUserId = (await this.moverUser(mover)).userId;
    const gateLocal = await this.countryConfig.getIdGateThresholdLocal(order.customer.countryCode);
    if (amount >= gateLocal) {
      return {
        claim: null,
        riderNotice: {
          userId: moverUserId,
          type: 'SYSTEM_ANNOUNCEMENT',
          title: 'Not covered by the guarantee',
          body: `Orders of $${Math.round(gateLocal).toLocaleString()} or more are outside the automatic guarantee. Support will follow up.`,
          data: { kind: 'claim_over_gate', orderId: order.id },
        },
      };
    }
    const rules = await this.configFor(order.customer.countryCode);
    const flags = await this.guardrailFlags(mover, order.customer.id, order.customer.phone, addressKey, rules, tx);
    if (order.deliveryLat != null && order.deliveryLng != null) {
      const km = haversineDistance(input.gps.lat, input.gps.lng, order.deliveryLat, order.deliveryLng);
      if (km > rules.maxHandoverDistanceKm) flags.push('gps_far');
    }
    // [DOC-1 §31.4 · P31-1] The policy's own guardrails: the rolling 30-day cap per
    // mover, the human-review threshold, a suspended protection, and — DOC-INV-47 — the
    // evidence bundle, assembled here from the artefacts and stored for the reviewer.
    // Each routes the claim to a person; none refuses it. The evidence is kept either way.
    const now = new Date();
    const already = await rollingClaimTotal(tx, mover, now);
    if (already + amount > gateLocal * rules.rlpMonthlyCapMultiple) flags.push(LOSS_PROTECTION_FLAGS.overMonthlyCap);
    if (amount > gateLocal * rules.rlpReviewFraction) flags.push(LOSS_PROTECTION_FLAGS.overReviewThreshold);
    const moverAccount = await tx.user.findUnique({ where: { id: moverUserId }, select: { lossProtectionSuspendedAt: true } });
    const suspended = Boolean(moverAccount?.lossProtectionSuspendedAt);
    if (suspended) flags.push(LOSS_PROTECTION_FLAGS.protectionSuspended);
    // The photo at the door: the delivery app sends `photoUrl`; the courier app sends its proof photo.
    const doorPhoto = input.photoUrl ?? input.courierProofPhotoUrl ?? null;
    const evidence = await assembleClaimEvidence(
      tx,
      { orderId: order.id, riderId: mover.riderId, driverId: mover.driverId, gpsLat: input.gps.lat, gpsLng: input.gps.lng, photoUrl: doorPhoto, createdAt: now },
      { maxHandoverDistanceKm: rules.maxHandoverDistanceKm },
    );
    if (!evidence.complete) flags.push(LOSS_PROTECTION_FLAGS.evidenceIncomplete);
    const claim = await tx.reimbursementClaim.create({
      data: {
        orderId: order.id,
        riderId: mover.riderId,
        driverId: mover.driverId,
        customerId: order.customer.id,
        amount,
        reason: input.outcome,
        gpsLat: input.gps.lat,
        gpsLng: input.gps.lng,
        photoUrl: doorPhoto,
        flags,
        status: flags.length === 0 ? 'AUTO_APPROVED' : 'PENDING_REVIEW',
        evidence: evidence as unknown as Prisma.InputJsonValue,
        evidenceComplete: evidence.complete,
        createdAt: now,
      },
    });
    return {
      claim,
      riderNotice: {
        userId: moverUserId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: claim.status === 'AUTO_APPROVED' ? 'Guarantee approved' : 'Claim under review',
        body: claim.status === 'AUTO_APPROVED'
          ? `$${amount.toLocaleString()} is covered by the Swift guarantee and will be paid out.`
          : suspended
            ? 'Your loss protection is suspended, so this claim goes to a human review. Support has the reason and the review route.'
            : 'Your claim needs a quick manual review — we will get back to you.',
        data: { kind: 'claim', claimId: claim.id },
      },
    };
  }

  private async guardrailFlags(
    mover: ClaimMover,
    customerId: string,
    phone: string,
    addressKey: string,
    rules: CashRulesConfig,
    db: PrismaClient | Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    const flags: string[] = [];
    // [M-29] Every guardrail is keyed on the acting mover — rider or driver —
    // and a mover's peers are movers of the same kind.
    const mine = mover.riderId ? { riderId: mover.riderId } : { driverId: mover.driverId };
    const moverKey = (c: { riderId: string | null; driverId: string | null }) => (c.riderId ? `r:${c.riderId}` : `d:${c.driverId}`);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const window90 = new Date(Date.now() - 90 * DAY_MS);
    const window30 = new Date(Date.now() - 30 * DAY_MS);

    // Per-mover monthly cap
    const monthClaims = await db.reimbursementClaim.count({
      where: { ...mine, createdAt: { gte: monthStart } },
    });
    if (monthClaims >= rules.maxClaimsPerRiderPerMonth) flags.push('over_cap');

    // Claim-rate outlier vs peer average (movers of the same kind with any claim in 30d)
    const mine30 = await db.reimbursementClaim.count({
      where: { ...mine, createdAt: { gte: window30 } },
    });
    if (mine30 > 0) {
      const grouped = mover.riderId
        ? await db.reimbursementClaim.groupBy({
          by: ['riderId'],
          where: { createdAt: { gte: window30 }, riderId: { not: mover.riderId } },
          _count: true,
        })
        : await db.reimbursementClaim.groupBy({
          by: ['driverId'],
          where: { createdAt: { gte: window30 }, driverId: { not: mover.driverId } },
          _count: true,
        });
      const peerAvg = grouped.length
        ? grouped.reduce((s, g) => s + g._count, 0) / grouped.length
        : 0;
      if (mine30 + 1 > rules.outlierMultiplier * Math.max(1, peerAvg)) flags.push('outlier');
    }

    // Collusion: the same customer showing up across movers' claims
    const sameTarget = await db.reimbursementClaim.findMany({
      where: { createdAt: { gte: window90 }, customerId },
      select: { riderId: true, driverId: true },
    });
    const distinctMovers = new Set(sameTarget.map(moverKey));
    distinctMovers.add(moverKey(mover));
    if (sameTarget.length > 0 && distinctMovers.size >= 2) flags.push('collusion_customer');

    // [DOC-1 §31.4 · P31-1 follow-up] "Repeat pairings → route to the identity graph": the same
    // PERSON behind several customer accounts is the signature the single-account check misses.
    // The customer's identity cluster (identity/identity.service, resolved by the graph's own
    // rules — never by claim behaviour) widens the two collusion reads to every account it holds.
    // An advisory, not a merge: it flags, a person decides.
    const cluster = (await clusterMemberIds(this.prisma, customerId)).filter((id) => id !== customerId);
    if (cluster.length > 0) {
      const clusterClaims = await db.reimbursementClaim.findMany({
        where: { createdAt: { gte: window90 }, customerId: { in: cluster } },
        select: { riderId: true, driverId: true },
      });
      if (clusterClaims.length > 0) {
        flags.push('collusion_customer_cluster');
        if (clusterClaims.some((c) => moverKey(c) === moverKey(mover))) flags.push('collusion_pair_cluster');
      }
    }

    // One mover repeatedly against one customer
    const pairCount = await db.reimbursementClaim.count({
      where: { ...mine, customerId, createdAt: { gte: window90 } },
    });
    if (pairCount >= 1) flags.push('collusion_pair');

    // Same address fingerprint across claims (different accounts, same door)
    const addressHits = await this.prisma.strike.count({
      where: { addressKey, createdAt: { gte: window90 }, userId: { not: customerId } },
    });
    if (addressHits >= 1) flags.push('collusion_address');

    return [...new Set(flags)];
  }

  // -------------------------------------------------------------------------
  // Strike consequences — enforced at order placement
  // -------------------------------------------------------------------------

  async orderingRestriction(userId: string): Promise<'restricted' | 'banned' | null> {
    return orderingRestriction(this.prisma, userId);
  }

  // -------------------------------------------------------------------------
  // Claim review (admin) — beyond-cap/flagged claims are reviewed, not auto-paid
  // -------------------------------------------------------------------------

  async approveClaim(claimId: string, adminId: string, note?: string, onAudit?: OnAudit) {
    const updated = await this.transitionClaim(claimId, ['PENDING_REVIEW'], {
      status: 'APPROVED', reviewedBy: adminId, reviewNote: note, reviewedAt: new Date(),
    }, onAudit);
    await this.notifyClaim(updated, 'Claim approved', `Your $${Number(updated.amount).toLocaleString()} claim was approved and will be paid out.`, claimId);
    return updated;
  }

  async rejectClaim(claimId: string, adminId: string, note: string, onAudit?: OnAudit) {
    const updated = await this.transitionClaim(claimId, ['PENDING_REVIEW'], {
      status: 'REJECTED', reviewedBy: adminId, reviewNote: note, reviewedAt: new Date(),
    }, onAudit);
    await this.notifyClaim(updated, 'Claim rejected', `Your claim was rejected: ${note}`, claimId);
    return updated;
  }

  async markClaimPaid(claimId: string, adminId: string, paymentRef: string, paidAmount: unknown, onAudit?: OnAudit) {
    // [WR-004] PAID is a money fact on a manual rail — the reference (bank/MMG
    // ref, receipt number) IS the evidence. Without it the record attests a
    // payout nobody can trace, so it is required, not optional.
    //
    // [A-11] And the evidence has to hold up. The reference is normalised and
    // shaped so a single character cannot pass, it is UNIQUE in the database so
    // one transfer cannot close ten claims, and the payer states the amount
    // they actually sent — checked against the claim's own figure to the cent,
    // BEFORE anything is written.
    const reference = normaliseClaimPaymentRef(paymentRef);
    // reviewedBy: keep the original reviewer if there was one; else stamp the payer.
    const existing = await this.prisma.reimbursementClaim.findUnique({
      where: { id: claimId },
      select: { reviewedBy: true, amount: true, status: true, orderId: true, riderId: true, driverId: true, gpsLat: true, gpsLng: true, photoUrl: true, createdAt: true },
    });
    if (!existing) throw new NotFoundError('ReimbursementClaim', claimId);
    const attested = assertClaimAmountAttested(existing.amount, paidAmount);
    const claimOrder = await this.prisma.order.findUnique({ where: { id: existing.orderId }, select: { customer: { select: { countryCode: true } } } });
    if (!claimOrder) throw new NotFoundError('Order', existing.orderId);

    // [DOC-1 §31.4 · DOC-INV-47 · P31-1] Nobody pays without the bundle, and nobody
    // auto-pays a suspended mover. The bundle is re-derived from the artefacts NOW —
    // the stored copy is the reviewer's record, not the gate — and an AUTO_APPROVED
    // claim of a suspended mover must first be APPROVED by a person.
    const countryCode = claimOrder.customer.countryCode;
    if (existing.status === 'AUTO_APPROVED') {
      const mover = await this.moverUser(existing);
      const account = await this.prisma.user.findUnique({ where: { id: mover.userId }, select: { lossProtectionSuspendedAt: true } });
      if (account?.lossProtectionSuspendedAt) {
        throw new AppError(409, 'RLP_PROTECTION_SUSPENDED', 'This mover\'s loss protection is suspended; an auto-approved claim must be reviewed and approved by a person before it is paid.');
      }
    }
    const rules = await this.configFor(countryCode);
    assertEvidenceComplete(await assembleClaimEvidence(this.prisma, existing, { maxHandoverDistanceKm: rules.maxHandoverDistanceKm }));

    // The payout is DRAWN from the reserve line inside the same transaction as the
    // CAS and the audit row: a claim is paid from a funded line or not at all.
    const updated = await this.transitionClaim(claimId, ['AUTO_APPROVED', 'APPROVED'], {
      status: 'PAID', paidAt: new Date(), paymentRef: reference, paidAmount: attested,
      paidById: adminId, reviewedBy: existing?.reviewedBy ?? adminId,
    }, onAudit, async (tx) => {
      const drawn = await drawReserveForPayout(tx, { countryCode, claimId, amount: Number(existing.amount), byId: adminId });
      return { reserveBalanceAfter: drawn.balanceAfter };
    }).catch((err) => {
      if (isDuplicateReferenceError(err)) {
        throw new AppError(
          409,
          'PAYMENT_REF_ALREADY_USED',
          'That reference is already recorded against another claim. One transfer settles one claim — use the reference for THIS payout.',
        );
      }
      throw err;
    });
    await this.notifyClaim(updated, 'Guarantee paid', `$${Number(updated.amount).toLocaleString()} has been paid out to you.`, claimId);
    return updated;
  }

  /**
   * Atomic claim state transition — the single winner. This is a MONEY step
   * (markClaimPaid issues a real payout), so it must be compare-and-set, not a
   * read-then-write: two admins (or a double-click / retry) both reading
   * AUTO_APPROVED and both writing PAID would pay the rider twice. updateMany
   * with the status in the WHERE matches at most once; the loser sees count===0.
   */
  private async transitionClaim(
    claimId: string,
    from: string[],
    data: Record<string, unknown>,
    onAudit?: OnAudit,
    /** [P31-1] Money moved by the same transaction as the CAS (the reserve draw); its facts join the audit row. */
    within?: (tx: Prisma.TransactionClient) => Promise<Record<string, unknown>>,
  ) {
    // [ADM-002] The compare-and-set and the caller's audit row commit together;
    // a refused row leaves the claim exactly where it was.
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.reimbursementClaim.updateMany({
        where: { id: claimId, status: { in: from as never } },
        data: data as never,
      });
      if (res.count === 0) {
        const exists = await tx.reimbursementClaim.findUnique({ where: { id: claimId }, select: { status: true } });
        if (!exists) throw new NotFoundError('Claim', claimId);
        throw new AppError(400, 'INVALID_CLAIM_STATE', `Claim is ${exists.status}; expected ${from.join('/')}`);
      }
      const facts = within ? await within(tx) : {};
      const updated = await tx.reimbursementClaim.findUniqueOrThrow({ where: { id: claimId } });
      await onAudit?.(tx, { status: updated.status, amount: String(updated.amount), ...facts });
      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // [DOC-1 §31.4 · P31-1] Loss protection: suspension and the reserve line
  // -------------------------------------------------------------------------

  /** Suspension is a stated, audited, reversible act — never silent. The mover is told. */
  async suspendLossProtection(userId: string, reason: string, onAudit?: OnAudit) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, lossProtectionSuspendedAt: true, lossProtectionSuspendedReason: true } });
    if (!user) throw new NotFoundError('User', userId);
    if (user.lossProtectionSuspendedAt) return user; // already suspended — the fact stands, nothing is re-announced
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: userId },
        data: { lossProtectionSuspendedAt: new Date(), lossProtectionSuspendedReason: reason },
        select: { id: true, lossProtectionSuspendedAt: true, lossProtectionSuspendedReason: true },
      });
      await onAudit?.(tx, { lossProtectionSuspendedAt: row.lossProtectionSuspendedAt?.toISOString() ?? null, reason });
      return row;
    });
    await this.notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Loss protection suspended',
      body: 'Your loss protection has been suspended following a review. Claims you file will be reviewed by a person before any payout; contact support to request a review of this decision.',
      data: { kind: 'rlp_suspended' },
    }).catch(() => {});
    return updated;
  }

  async reinstateLossProtection(userId: string, note: string | undefined, onAudit?: OnAudit) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, lossProtectionSuspendedAt: true, lossProtectionSuspendedReason: true } });
    if (!user) throw new NotFoundError('User', userId);
    if (!user.lossProtectionSuspendedAt) return user;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: userId },
        data: { lossProtectionSuspendedAt: null, lossProtectionSuspendedReason: null },
        select: { id: true, lossProtectionSuspendedAt: true, lossProtectionSuspendedReason: true },
      });
      await onAudit?.(tx, { reinstated: true, note: note ?? null });
      return row;
    });
    await this.notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Loss protection reinstated',
      body: 'Your loss protection is active again. Claims below the gate are covered as before.',
      data: { kind: 'rlp_reinstated' },
    }).catch(() => {});
    return updated;
  }

  /** The reserve line as the operator sees it: balance, floor, this month's provisioning, the latest entries. */
  async lossProtectionReserve(countryCode: string) {
    const [gateLocal, rules] = await Promise.all([this.countryConfig.getIdGateThresholdLocal(countryCode), this.configFor(countryCode)]);
    return reserveStatement(this.prisma, countryCode, { gateLocal, rules });
  }

  /** An audited manual entry on the reserve line: a top-up or a correction. */
  async adjustLossProtectionReserve(countryCode: string, amount: number, adminId: string, note: string, onAudit?: OnAudit) {
    return this.prisma.$transaction(async (tx) => {
      const entry = await adjustReserve(tx, { countryCode, amount, byId: adminId, note });
      await onAudit?.(tx, { countryCode, amount, entryId: entry.id, reserveBalanceAfter: entry.balanceAfter });
      return entry;
    });
  }

  private async notifyClaim(claim: { riderId: string | null; driverId: string | null }, title: string, body: string, claimId: string) {
    const mover = await this.moverUser(claim);
    await this.notifications.send({
      userId: mover.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title,
      body,
      data: { kind: 'claim_update', claimId },
    });
  }

  // -------------------------------------------------------------------------
  // L3 — earned trust
  // -------------------------------------------------------------------------

  /** Completed paid orders + zero strikes + account age -> reduced friction. */
  async maybePromoteToL3(userId: string, countryCode: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { trustLevel: true, createdAt: true },
    });
    if (!user || user.trustLevel !== 'L2') return false;

    const rules = await this.configFor(countryCode);
    const ageDays = (Date.now() - user.createdAt.getTime()) / DAY_MS;
    if (ageDays < rules.l3MinAccountAgeDays) return false;

    const strikes = await this.prisma.strike.count({ where: { userId } });
    if (strikes > 0) return false;

    const paidOrders = await this.prisma.order.count({
      where: { customerId: userId, status: { in: ['DELIVERED', 'COMPLETED'] }, paymentStatus: 'CAPTURED' },
    });
    if (paidOrders < rules.l3MinPaidOrders) return false;

    await this.prisma.user.update({ where: { id: userId }, data: { trustLevel: 'L3' } });
    // D.3 — L3 raises the rider's float limit (no-op for non-riders).
    await new FloatService(this.prisma).recomputeForUser(userId);
    await this.notifications.send({
      userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Trusted status earned',
      body: 'Thanks for your track record — you now enjoy reduced checks across Swift.',
      data: { kind: 'trust_l3' },
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Founder metrics
  // -------------------------------------------------------------------------

  async founderMetrics() {
    const window30 = new Date(Date.now() - 30 * DAY_MS);

    const [failed, completed, payoutAgg, byRider, byDriver] = await Promise.all([
      this.prisma.order.count({ where: { status: 'FAILED', placedAt: { gte: window30 } } }),
      this.prisma.order.count({ where: { status: { in: ['DELIVERED', 'COMPLETED'] }, placedAt: { gte: window30 } } }),
      this.prisma.reimbursementClaim.aggregate({
        where: { status: { in: ['AUTO_APPROVED', 'APPROVED', 'PAID'] }, createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.reimbursementClaim.groupBy({
        by: ['riderId'],
        where: { createdAt: { gte: window30 }, riderId: { not: null } },
        _count: true,
        _sum: { amount: true },
        orderBy: { _count: { riderId: 'desc' } },
        take: 20,
      }),
      // [M-29] A ride's guarantee claim names the driver.
      this.prisma.reimbursementClaim.groupBy({
        by: ['driverId'],
        where: { createdAt: { gte: window30 }, driverId: { not: null } },
        _count: true,
        _sum: { amount: true },
        orderBy: { _count: { driverId: 'desc' } },
        take: 20,
      }),
    ]);

    const total = failed + completed;
    return {
      failedPaymentPct: total === 0 ? 0 : Math.round((failed / total) * 1000) / 10,
      guaranteePayoutsThisWeek: {
        total: Number(payoutAgg._sum.amount ?? 0),
        count: payoutAgg._count,
      },
      claimsByRider: byRider.map((r) => ({
        riderId: r.riderId,
        claims: r._count,
        amount: Number(r._sum.amount ?? 0),
      })),
      claimsByDriver: byDriver.map((d) => ({
        driverId: d.driverId,
        claims: d._count,
        amount: Number(d._sum.amount ?? 0),
      })),
    };
  }

  /** The user behind a claim's mover — the rider, or [M-29] the driver. */
  private async moverUser(mover: { riderId: string | null; driverId: string | null }) {
    if (mover.riderId) return this.prisma.rider.findUniqueOrThrow({ where: { id: mover.riderId }, select: { userId: true } });
    if (mover.driverId) return this.prisma.driver.findUniqueOrThrow({ where: { id: mover.driverId }, select: { userId: true } });
    throw new AppError(500, 'CLAIM_WITHOUT_MOVER', 'A guarantee claim must name a rider or a driver.');
  }
}

export interface VendorRiderAffinity {
  vendorId: string;
  riderId: string;
  claims: number;
}

/**
 * SWIFT-164 — vendor↔rider collusion affinity scan.
 *
 * The per-claim guardrails model rider↔customer and same-door collusion, but the
 * VENDOR is not a node in that graph: a vendor that funnels fabricated failed
 * deliveries to one favoured rider (splitting the guarantee payout) is invisible
 * on the first cycle. This periodic scan counts guarantee claims by
 * (vendorId, riderId) over a window and returns pairs at or above a threshold so
 * a human can review them. Detection only — it never takes an automatic money
 * action (hard rule 1). Courier/taxi claims have no vendor node and are skipped.
 */
export async function scanVendorRiderClaimAffinity(
  prisma: PrismaClient,
  opts: { sinceDays?: number; minClaims?: number } = {},
): Promise<VendorRiderAffinity[]> {
  const sinceDays = opts.sinceDays ?? 90;
  const minClaims = opts.minClaims ?? 3;
  const since = new Date(Date.now() - sinceDays * DAY_MS);

  const claims = await prisma.reimbursementClaim.findMany({
    where: { createdAt: { gte: since } },
    select: { orderId: true, riderId: true },
  });
  if (claims.length === 0) return [];

  // The claim carries orderId, not vendorId — resolve the vendor per order.
  const vendorByOrder = new Map<string, string>();
  const orders = await prisma.order.findMany({
    where: { id: { in: claims.map((c) => c.orderId) }, vendorId: { not: null } },
    select: { id: true, vendorId: true },
  });
  for (const o of orders) if (o.vendorId) vendorByOrder.set(o.id, o.vendorId);

  const counts = new Map<string, VendorRiderAffinity>();
  for (const c of claims) {
    const vendorId = vendorByOrder.get(c.orderId);
    if (!vendorId || !c.riderId) continue; // courier/taxi claim — no vendor node, or no rider [M-29]
    const key = `${vendorId}::${c.riderId}`;
    const cur = counts.get(key) ?? { vendorId, riderId: c.riderId, claims: 0 };
    cur.claims += 1;
    counts.set(key, cur);
  }

  return [...counts.values()]
    .filter((p) => p.claims >= minClaims)
    .sort((a, b) => b.claims - a.claims);
}
