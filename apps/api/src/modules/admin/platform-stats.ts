/**
 * [DASH] The founder's dashboard numbers, as one function so they can be
 * graded without a request.
 *
 * [STA-1 DL-4 / RLS-N6] Every count of people or money here names PRODUCTION
 * rows explicitly (lib/production-only.ts) on top of the tenant wall: run
 * with no tenant context at all — as a job or a report would — it still
 * cannot count the store-review fiction.
 */
import type { PrismaClient } from '@prisma/client';
import { PRODUCTION_TENANT, REAL_PEOPLE } from '../../lib/production-only';

export interface PlatformStatsInput {
  tenantId: string;
  /** Guyana-local start of today (DASH-06). */
  today: Date;
  /** The subscription rows this tenant may see (subscriptionTenantScope). */
  subscriptionScope: Record<string, unknown>;
}

export async function platformStats(prisma: PrismaClient, { tenantId, today, subscriptionScope }: PlatformStatsInput) {
  const [
    totalUsers,
    totalOrders,
    todayOrders,
    todayRevenue,
    activeRiders,
    activeDrivers,
    activeVendors,
    totalVendors,
    activeSubscriptions,
    todayNewUsers,
    pendingVendors,
    pastDueSubs,
    unassignedOrders,
  ] = await Promise.all([
      prisma.user.count({ where: REAL_PEOPLE }),
      prisma.order.count({ where: PRODUCTION_TENANT }),
      prisma.order.count({ where: { placedAt: { gte: today }, ...PRODUCTION_TENANT } }),
      prisma.order.aggregate({
        where: { placedAt: { gte: today }, status: { in: ['DELIVERED', 'COMPLETED'] }, ...PRODUCTION_TENANT },
        _sum: { deliveryFee: true, totalAmount: true },
        _count: true,
      }),
      prisma.rider.count({ where: { isOnline: true, user: { tenantId, ...REAL_PEOPLE } } }),
      prisma.driver.count({ where: { isOnline: true, user: { tenantId, ...REAL_PEOPLE } } }),
      prisma.vendor.count({ where: { status: 'ACTIVE', ...REAL_PEOPLE } }),
      prisma.vendor.count({ where: REAL_PEOPLE }),
      // DASH-01: real per-type revenue = the SUMMED weeklyRate of ACTIVE subs,
      // never count × a hardcoded rate table (which undercounted large vendors
      // 33% and counted TRIAL/PAST_DUE/CANCELLED as revenue). ACTIVE-only so
      // the per-type lines reconcile with the weeklySubscriptionRevenue total.
      // [A-07] The rows, not a `_sum`. A database aggregate cannot express
      // "customRate if set, else weeklyRate, and nothing at all if waived" —
      // which is exactly what the biller charges. Summing `weeklyRate` reported
      // every custom-priced subscription at its LIST price and every waived one
      // as full revenue for a period it will be charged nothing. Active
      // subscriptions are bounded (hundreds), and this keeps Prisma's tenant
      // scoping, which raw SQL would not.
      prisma.subscription.findMany({
        where: { status: 'ACTIVE', ...subscriptionScope },
        select: { type: true, weeklyRate: true, customRate: true, feeWaived: true },
      }),
      prisma.user.count({ where: { createdAt: { gte: today }, ...REAL_PEOPLE } }),
      // SWIFT-118: the weeklyTrend raw SQL was removed — it was computed on every
      // 30s dashboard poll (an UNSCOPED FROM orders, cross-tenant) but never
      // rendered by any admin component. Deleted (rule 17); re-add scoped + wired
      // if a trend chart ships.
      // Operational alerts — real counts for the dashboard AlertsPanel.
      prisma.vendor.count({ where: { status: 'PENDING_APPROVAL', ...REAL_PEOPLE } }),
      prisma.subscription.count({ where: { status: 'PAST_DUE', ...subscriptionScope } }),
      prisma.order.count({
        where: {
          riderId: null,
          ...PRODUCTION_TENANT,
          status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
          placedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
          // A held order (LIFECYCLE_V2) is waiting on the customer, not ops.
          AND: [{ OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }] }],
        },
      }),
      ]);
  return { totalUsers, totalOrders, todayOrders, todayRevenue, activeRiders, activeDrivers, activeVendors, totalVendors, activeSubscriptions, todayNewUsers, pendingVendors, pastDueSubs, unassignedOrders };
}
