import type { PrismaClient, ReimbursementClaim } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';
import { OrderService } from '../order/order.service';

// ---------------------------------------------------------------------------
// Cash rules engine (master plan §5) — the golden rule as code. Payment
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
    const claim = await this.requireClaim(claimId, ['PENDING_REVIEW']);
    const updated = await this.prisma.reimbursementClaim.update({
      where: { id: claim.id },
      data: { status: 'APPROVED', reviewedBy: adminId, reviewNote: note, reviewedAt: new Date() },
    });
    await this.notifyClaim(updated.riderId, 'Claim approved', `Your $${Number(updated.amount).toLocaleString()} claim was approved and will be paid out.`, claimId);
    return updated;
  }

  async rejectClaim(claimId: string, adminId: string, note: string) {
    const claim = await this.requireClaim(claimId, ['PENDING_REVIEW']);
    const updated = await this.prisma.reimbursementClaim.update({
      where: { id: claim.id },
      data: { status: 'REJECTED', reviewedBy: adminId, reviewNote: note, reviewedAt: new Date() },
    });
    await this.notifyClaim(updated.riderId, 'Claim rejected', `Your claim was rejected: ${note}`, claimId);
    return updated;
  }

  async markClaimPaid(claimId: string, adminId: string, paymentRef?: string) {
    const claim = await this.requireClaim(claimId, ['AUTO_APPROVED', 'APPROVED']);
    const updated = await this.prisma.reimbursementClaim.update({
      where: { id: claim.id },
      data: { status: 'PAID', paidAt: new Date(), paymentRef, reviewedBy: claim.reviewedBy ?? adminId },
    });
    await this.notifyClaim(updated.riderId, 'Guarantee paid', `$${Number(updated.amount).toLocaleString()} has been paid out to you.`, claimId);
    return updated;
  }

  private async requireClaim(claimId: string, allowed: string[]) {
    const claim = await this.prisma.reimbursementClaim.findUnique({ where: { id: claimId } });
    if (!claim) throw new NotFoundError('Claim', claimId);
    if (!allowed.includes(claim.status)) {
      throw new AppError(400, 'INVALID_CLAIM_STATE', `Claim is ${claim.status}; expected ${allowed.join('/')}`);
    }
    return claim;
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
