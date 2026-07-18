import type { PrismaClient, ReimbursementClaim } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';
import { OrderService } from '../order/order.service';
import { FloatService } from '../dispatch/float.service';

// ---------------------------------------------------------------------------
// Cash rules engine — the golden rule as code. Payment
// happens before handover; a failed handover under the USD gate becomes a
// company-guaranteed claim with GPS evidence, the customer takes a strike,
// and deterministic guardrails (caps, outliers, collusion patterns) route
// suspicious claims to manual review instead of auto-payout. Rider trust
// depends on this; no AI ever decides a money outcome.
// ---------------------------------------------------------------------------

export interface CashRulesConfig {
  maxClaimsPerRiderPerMonth: number;
  strikeRestrictThreshold: number;
  strikeBanThreshold: number;
  l3MinPaidOrders: number;
  l3MinAccountAgeDays: number;
  outlierMultiplier: number;
}

export const DEFAULT_CASH_RULES: CashRulesConfig = {
  maxClaimsPerRiderPerMonth: 3,
  strikeRestrictThreshold: 2,
  strikeBanThreshold: 4,
  l3MinPaidOrders: 20,
  l3MinAccountAgeDays: 30,
  outlierMultiplier: 3,
};

/** Handover is only legal at the door. */
const HANDOVER_STATES = ['ARRIVED'] as const;

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

  const strikes = await prisma.strike.count({
    where: { userId, createdAt: { gte: new Date(Date.now() - 90 * DAY_MS) } },
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

export class CashRulesService {
  private countryConfig: CountryConfigService;

  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
    private orders: OrderService,
  ) {
    this.countryConfig = new CountryConfigService(prisma);
  }

  async configFor(countryCode: string): Promise<CashRulesConfig> {
    const config = await this.countryConfig.getByCode(countryCode);
    return { ...DEFAULT_CASH_RULES, ...((config.cashRules as Partial<CashRulesConfig> | null) ?? {}) };
  }

  // -------------------------------------------------------------------------
  // The handover — golden rule enforcement point
  // -------------------------------------------------------------------------

  async handover(
    orderId: string,
    riderUserId: string,
    input: { outcome: 'paid' | 'no_show' | 'refused'; gps: { lat: number; lng: number }; photoUrl?: string },
  ) {
    const rider = await this.prisma.rider.findUnique({ where: { userId: riderUserId }, select: { id: true } });
    if (!rider) throw new NotFoundError('Rider');

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, riderId: rider.id },
      include: { customer: { select: { id: true, phone: true, countryCode: true, trustLevel: true, createdAt: true } } },
    });
    if (!order) throw new NotFoundError('Order', orderId);

    if (!HANDOVER_STATES.includes(order.status as (typeof HANDOVER_STATES)[number])) {
      throw new AppError(409, 'NOT_AT_DOOR', `Handover is only available at the delivery point (order is ${order.status})`);
    }

    const gpsNote = `gps:${input.gps.lat.toFixed(5)},${input.gps.lng.toFixed(5)}`;

    if (input.outcome === 'paid') {
      // Golden rule satisfied: payment collected, THEN handover completes
      await this.prisma.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'CAPTURED' },
      });
      const updated = await this.orders.updateStatus(orderId, 'DELIVERED', riderUserId, `payment collected — ${gpsNote}`);
      await this.orders.createEarnings(orderId);
      await this.maybePromoteToL3(order.customer.id, order.customer.countryCode);
      return { order: updated, claim: null };
    }

    // Failed handover: order fails through the state machine, evidence intact
    const failed = await this.orders.updateStatus(
      orderId,
      'FAILED',
      riderUserId,
      `${input.outcome} — ${gpsNote}${input.photoUrl ? ' photo:yes' : ''}`,
    );
    await this.prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: 'FAILED' },
    });

    // Strike the customer — phone + address fingerprint feed collusion checks
    const addressKey = `geo:${order.deliveryLat.toFixed(4)}:${order.deliveryLng.toFixed(4)}`;
    await this.prisma.strike.create({
      data: {
        userId: order.customer.id,
        orderId,
        reason: `failed_payment_${input.outcome}`,
        phone: order.customer.phone,
        addressKey,
      },
    });
    await this.notifications.send({
      userId: order.customer.id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Failed delivery recorded',
      body: 'Your order was not paid for at the door. Repeated incidents restrict your account.',
      data: { kind: 'strike', orderId },
    });

    const claim = await this.createClaim(order, rider.id, input, addressKey);

    return { order: failed, claim };
  }

  // -------------------------------------------------------------------------
  // Claims + guardrails
  // -------------------------------------------------------------------------

  private async createClaim(
    order: { id: string; totalAmount: unknown; customer: { id: string; phone: string; countryCode: string } },
    riderId: string,
    input: { outcome: 'paid' | 'no_show' | 'refused'; gps: { lat: number; lng: number }; photoUrl?: string },
    addressKey: string,
  ): Promise<ReimbursementClaim | null> {
    const amount = Number(order.totalAmount);
    const gateLocal = await this.countryConfig.getIdGateThresholdLocal(order.customer.countryCode);

    // The company guarantee covers sub-gate orders only (>= gate required L2
    // at checkout anyway — those are review territory, not auto-money)
    if (amount >= gateLocal) {
      await this.notifications.send({
        userId: (await this.riderUser(riderId)).userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Not covered by the guarantee',
        body: `Orders of $${Math.round(gateLocal).toLocaleString()} or more are outside the automatic guarantee. Support will follow up.`,
        data: { kind: 'claim_over_gate', orderId: order.id },
      });
      return null;
    }

    const rules = await this.configFor(order.customer.countryCode);
    const flags = await this.guardrailFlags(riderId, order.customer.id, order.customer.phone, addressKey, rules);

    const claim = await this.prisma.reimbursementClaim.create({
      data: {
        orderId: order.id,
        riderId,
        customerId: order.customer.id,
        amount,
        reason: input.outcome,
        gpsLat: input.gps.lat,
        gpsLng: input.gps.lng,
        photoUrl: input.photoUrl,
        flags,
        status: flags.length === 0 ? 'AUTO_APPROVED' : 'PENDING_REVIEW',
      },
    });

    await this.notifications.send({
      userId: (await this.riderUser(riderId)).userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: claim.status === 'AUTO_APPROVED' ? 'Guarantee approved' : 'Claim under review',
      body: claim.status === 'AUTO_APPROVED'
        ? `$${amount.toLocaleString()} is covered by the Swift guarantee and will be paid out.`
        : 'Your claim needs a quick manual review — we will get back to you.',
      data: { kind: 'claim', claimId: claim.id },
    });

    return claim;
  }

  /** Deterministic, explainable flags — synthetic patterns prove each one. */
  private async guardrailFlags(
    riderId: string,
    customerId: string,
    phone: string,
    addressKey: string,
    rules: CashRulesConfig,
  ): Promise<string[]> {
    const flags: string[] = [];
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const window90 = new Date(Date.now() - 90 * DAY_MS);
    const window30 = new Date(Date.now() - 30 * DAY_MS);

    // Per-rider monthly cap
    const monthClaims = await this.prisma.reimbursementClaim.count({
      where: { riderId, createdAt: { gte: monthStart } },
    });
    if (monthClaims >= rules.maxClaimsPerRiderPerMonth) flags.push('over_cap');

    // Claim-rate outlier vs peer average (riders with any claim in 30d)
    const mine30 = await this.prisma.reimbursementClaim.count({
      where: { riderId, createdAt: { gte: window30 } },
    });
    if (mine30 > 0) {
      const grouped = await this.prisma.reimbursementClaim.groupBy({
        by: ['riderId'],
        where: { createdAt: { gte: window30 }, riderId: { not: riderId } },
        _count: true,
      });
      const peerAvg = grouped.length
        ? grouped.reduce((s, g) => s + g._count, 0) / grouped.length
        : 0;
      if (mine30 + 1 > rules.outlierMultiplier * Math.max(1, peerAvg)) flags.push('outlier');
    }

    // Collusion: the same customer showing up across riders' claims
    const sameTarget = await this.prisma.reimbursementClaim.findMany({
      where: { createdAt: { gte: window90 }, customerId },
      select: { riderId: true },
    });
    const distinctRiders = new Set(sameTarget.map((c) => c.riderId));
    distinctRiders.add(riderId);
    if (sameTarget.length > 0 && distinctRiders.size >= 2) flags.push('collusion_customer');

    // One rider repeatedly against one customer
    const pairCount = await this.prisma.reimbursementClaim.count({
      where: { riderId, customerId, createdAt: { gte: window90 } },
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

  async approveClaim(claimId: string, adminId: string, note?: string) {
    const updated = await this.transitionClaim(claimId, ['PENDING_REVIEW'], {
      status: 'APPROVED', reviewedBy: adminId, reviewNote: note, reviewedAt: new Date(),
    });
    await this.notifyClaim(updated.riderId, 'Claim approved', `Your $${Number(updated.amount).toLocaleString()} claim was approved and will be paid out.`, claimId);
    return updated;
  }

  async rejectClaim(claimId: string, adminId: string, note: string) {
    const updated = await this.transitionClaim(claimId, ['PENDING_REVIEW'], {
      status: 'REJECTED', reviewedBy: adminId, reviewNote: note, reviewedAt: new Date(),
    });
    await this.notifyClaim(updated.riderId, 'Claim rejected', `Your claim was rejected: ${note}`, claimId);
    return updated;
  }

  async markClaimPaid(claimId: string, adminId: string, paymentRef?: string) {
    // reviewedBy: keep the original reviewer if there was one; else stamp the payer.
    const existing = await this.prisma.reimbursementClaim.findUnique({ where: { id: claimId }, select: { reviewedBy: true } });
    const updated = await this.transitionClaim(claimId, ['AUTO_APPROVED', 'APPROVED'], {
      status: 'PAID', paidAt: new Date(), paymentRef, reviewedBy: existing?.reviewedBy ?? adminId,
    });
    await this.notifyClaim(updated.riderId, 'Guarantee paid', `$${Number(updated.amount).toLocaleString()} has been paid out to you.`, claimId);
    return updated;
  }

  /**
   * Atomic claim state transition — the single winner. This is a MONEY step
   * (markClaimPaid issues a real payout), so it must be compare-and-set, not a
   * read-then-write: two admins (or a double-click / retry) both reading
   * AUTO_APPROVED and both writing PAID would pay the rider twice. updateMany
   * with the status in the WHERE matches at most once; the loser sees count===0.
   */
  private async transitionClaim(claimId: string, from: string[], data: Record<string, unknown>) {
    const res = await this.prisma.reimbursementClaim.updateMany({
      where: { id: claimId, status: { in: from as never } },
      data: data as never,
    });
    if (res.count === 0) {
      const exists = await this.prisma.reimbursementClaim.findUnique({ where: { id: claimId }, select: { status: true } });
      if (!exists) throw new NotFoundError('Claim', claimId);
      throw new AppError(400, 'INVALID_CLAIM_STATE', `Claim is ${exists.status}; expected ${from.join('/')}`);
    }
    return this.prisma.reimbursementClaim.findUniqueOrThrow({ where: { id: claimId } });
  }

  private async notifyClaim(riderId: string, title: string, body: string, claimId: string) {
    const rider = await this.riderUser(riderId);
    await this.notifications.send({
      userId: rider.userId,
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

    const [failed, completed, payoutAgg, byRider] = await Promise.all([
      this.prisma.order.count({ where: { status: 'FAILED', placedAt: { gte: window30 } } }),
      this.prisma.order.count({ where: { status: { in: ['DELIVERED', 'COMPLETED'] }, placedAt: { gte: window30 } } }),
      this.prisma.reimbursementClaim.aggregate({
        where: { status: { in: ['AUTO_APPROVED', 'APPROVED', 'PAID'] }, createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.reimbursementClaim.groupBy({
        by: ['riderId'],
        where: { createdAt: { gte: window30 } },
        _count: true,
        _sum: { amount: true },
        orderBy: { _count: { riderId: 'desc' } },
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
    };
  }

  private async riderUser(riderId: string) {
    return this.prisma.rider.findUniqueOrThrow({ where: { id: riderId }, select: { userId: true } });
  }
}
