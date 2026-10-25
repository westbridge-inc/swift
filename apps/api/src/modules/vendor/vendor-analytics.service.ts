import type { PrismaClient, OrderStatus } from '@prisma/client';
import { vendorVisibleFilter } from '../order/order.service';
import { startOfDayGY, dayKeyGY } from '../../utils/time-gy';

// Vendor Insights read-model, extracted verbatim from vendor.routes.ts so the
// route file stays thin and the (money-adjacent) analytics math is unit-testable
// in isolation. All methods are pure reads; auth (requireVendor MANAGER) stays
// in the route. Every method is pinned by a characterization test:
// vendor-overview-truth / vendor-analytics-ops / vendor-analytics-coverage /
// busy-hours / vendor-repeat-customers.
//
// [Q12] Every order this read-model counts is one the store can see on its
// board: never an order still held in the customer's free-cancel window, and
// never one cancelled inside it — the dashboard must not tell the store an
// order existed that its board never showed.
export class VendorAnalyticsService {
  constructor(private prisma: PrismaClient) {}

  /** The board's visibility rule, for every order aggregate below [Q12]. */
  private visible() {
    return vendorVisibleFilter(this.prisma);
  }

  /** Today / rolling-week / rolling-month order counts + net-of-discount sales,
   *  anchored to Guyana-local midnight (a UTC container would misbucket the last
   *  4h of each GY day). Live orders count; dead ones don't; the pending queue's
   *  count AND value come from one aggregate so the KPI reflects the whole queue. */
  async overview(vendorId: string) {
    const todayStart = startOfDayGY();
    const weekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);

    const completedStatuses = ['DELIVERED', 'COMPLETED'] as OrderStatus[];
    const liveOrderStatuses = { notIn: ['CANCELLED', 'REFUNDED'] as OrderStatus[] };

    const [vendor, todayOrders, weekOrders, monthOrders, todayRevenue, weekRevenue, monthRevenue, activeItems, pendingAgg] =
      await Promise.all([
        this.prisma.vendor.findUnique({
          where: { id: vendorId },
          select: { averageRating: true, totalRatings: true, totalOrders: true, isCurrentlyOpen: true, acceptingOrders: true },
        }),
        this.prisma.order.count({ where: { vendorId, status: liveOrderStatuses, placedAt: { gte: todayStart }, AND: [this.visible()] } }),
        this.prisma.order.count({ where: { vendorId, status: liveOrderStatuses, placedAt: { gte: weekStart }, AND: [this.visible()] } }),
        this.prisma.order.count({ where: { vendorId, status: liveOrderStatuses, placedAt: { gte: monthStart }, AND: [this.visible()] } }),
        this.prisma.order.aggregate({
          where: { vendorId, status: { in: completedStatuses }, placedAt: { gte: todayStart }, AND: [this.visible()] },
          _sum: { subtotalCustomer: true, discount: true },
        }),
        this.prisma.order.aggregate({
          where: { vendorId, status: { in: completedStatuses }, placedAt: { gte: weekStart }, AND: [this.visible()] },
          _sum: { subtotalCustomer: true, discount: true },
        }),
        this.prisma.order.aggregate({
          where: { vendorId, status: { in: completedStatuses }, placedAt: { gte: monthStart }, AND: [this.visible()] },
          _sum: { subtotalCustomer: true, discount: true },
        }),
        this.prisma.item.count({ where: { vendorId, isAvailable: true } }),
        this.prisma.order.aggregate({
          where: { vendorId, status: 'PENDING', AND: [this.visible()] },
          _count: true,
          _sum: { totalAmount: true },
        }),
      ]);

    return {
      vendor: {
        averageRating: vendor?.averageRating ?? 0,
        totalRatings: vendor?.totalRatings ?? 0,
        totalOrders: vendor?.totalOrders ?? 0,
        isCurrentlyOpen: vendor?.isCurrentlyOpen ?? false,
        acceptingOrders: vendor?.acceptingOrders ?? false,
      },
      today: { orders: todayOrders, revenue: Number(todayRevenue._sum?.subtotalCustomer ?? 0) - Number(todayRevenue._sum?.discount ?? 0) },
      week: { orders: weekOrders, revenue: Number(weekRevenue._sum?.subtotalCustomer ?? 0) - Number(weekRevenue._sum?.discount ?? 0) },
      month: { orders: monthOrders, revenue: Number(monthRevenue._sum?.subtotalCustomer ?? 0) - Number(monthRevenue._sum?.discount ?? 0) },
      activeMenuItems: activeItems,
      pendingOrders: pendingAgg._count,
      queueValue: Number(pendingAgg._sum.totalAmount ?? 0),
    };
  }

  /** Operational quality over a window, all from real order timestamps: how fast
   *  orders are accepted, how honest the prep quote is, how often orders die.
   *  Acceptance is judged on DECIDED orders (accepted or vendor-killed) — a
   *  customer cancel before acceptance is not held against the store. Only
   *  orders the store could see count: never one still held, nor one the
   *  customer cancelled inside its hold [Q12]. */
  async ops(vendorId: string, days: number) {
    const since = startOfDayGY(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

    const orders = await this.prisma.order.findMany({
      where: { vendorId, placedAt: { gte: since }, AND: [this.visible()] },
      select: { status: true, placedAt: true, acceptedAt: true, readyAt: true, estimatedPrepTime: true, cancelledBy: true },
    });

    const placed = orders.length;
    const accepted = orders.filter((o) => o.acceptedAt);
    const cancelled = orders.filter((o) => o.status === 'CANCELLED' || o.status === 'REFUNDED');
    const vendorCancelled = cancelled.filter((o) => (o.cancelledBy ?? '').toUpperCase().includes('VENDOR'));
    const decided = accepted.length + vendorCancelled.length;

    const avgMinutes = (pairs: Array<[Date, Date]>) =>
      pairs.length ? pairs.reduce((sum, [a, b]) => sum + (b.getTime() - a.getTime()) / 60000, 0) / pairs.length : null;

    const acceptPairs = accepted
      .filter((o) => o.acceptedAt! >= o.placedAt)
      .map((o) => [o.placedAt, o.acceptedAt!] as [Date, Date]);
    const prepPairs = orders
      .filter((o) => o.acceptedAt && o.readyAt && o.readyAt >= o.acceptedAt)
      .map((o) => [o.acceptedAt!, o.readyAt!] as [Date, Date]);
    const quoted = orders.filter((o) => o.acceptedAt && o.readyAt && o.estimatedPrepTime != null);
    const avgQuotedPrep = quoted.length ? quoted.reduce((s, o) => s + (o.estimatedPrepTime ?? 0), 0) / quoted.length : null;

    const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

    return {
      days,
      placedOrders: placed,
      acceptanceRate: decided ? Math.round((accepted.length / decided) * 100) : null,
      cancellationRate: placed ? Math.round((cancelled.length / placed) * 100) : null,
      vendorCancellations: vendorCancelled.length,
      avgAcceptMinutes: round1(avgMinutes(acceptPairs)),
      avgPrepMinutes: round1(avgMinutes(prepPairs)),
      avgQuotedPrepMinutes: round1(avgQuotedPrep),
    };
  }

  /** Daily net-of-discount sales over the window, bucketed by Guyana day with
   *  gaps pre-filled to zero. Canonical sales = Σ(subtotalCustomer − discount),
   *  matching the overview + statement. */
  async revenue(vendorId: string, days: number) {
    const since = startOfDayGY(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    const completedStatuses = ['DELIVERED', 'COMPLETED'] as OrderStatus[];

    const orders = await this.prisma.order.findMany({
      where: { vendorId, status: { in: completedStatuses }, placedAt: { gte: since }, AND: [this.visible()] },
      select: { placedAt: true, subtotalCustomer: true, discount: true, totalAmount: true },
      orderBy: { placedAt: 'asc' },
    });

    const dailyMap = new Map<string, { date: string; orders: number; revenue: number; total: number }>();
    for (let d = 0; d < days; d++) {
      const date = new Date(since.getTime() + d * 24 * 60 * 60 * 1000);
      const key = dayKeyGY(date);
      dailyMap.set(key, { date: key, orders: 0, revenue: 0, total: 0 });
    }

    for (const o of orders) {
      const key = dayKeyGY(o.placedAt);
      const entry = dailyMap.get(key);
      if (entry) {
        entry.orders += 1;
        entry.revenue += Number(o.subtotalCustomer) - Number(o.discount);
        entry.total += Number(o.totalAmount);
      }
    }

    const daily = Array.from(dailyMap.values());
    return {
      days,
      daily,
      totals: {
        orders: orders.length,
        revenue: daily.reduce((s, d) => s + d.revenue, 0),
        total: daily.reduce((s, d) => s + d.total, 0),
      },
    };
  }

  /** Orders by Guyana-local hour of day over the last 30 days (UTC−4 year-round). */
  async busyHours(vendorId: string) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const orders = await this.prisma.order.findMany({
      where: { vendorId, placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] }, AND: [this.visible()] },
      select: { placedAt: true },
    });

    const GUYANA_OFFSET_HOURS = -4;
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));
    for (const o of orders) {
      const local = (o.placedAt.getUTCHours() + GUYANA_OFFSET_HOURS + 24) % 24;
      hours[local]!.orders += 1;
    }
    const peak = hours.reduce((best, h) => (h.orders > best.orders ? h : best), hours[0]!);

    return { days: 30, hours, peak: peak.orders > 0 ? peak : null, total: orders.length };
  }

  /** Top items by lifetime totalOrdered, each enriched with its 30-day quantity. */
  async popularItems(vendorId: string, limit: number) {
    const items = await this.prisma.item.findMany({
      where: { vendorId },
      orderBy: { totalOrdered: 'desc' },
      take: limit,
      select: { id: true, name: true, basePrice: true, imageUrl: true, totalOrdered: true, isAvailable: true, category: { select: { id: true, name: true } } },
    });

    const since = new Date();
    since.setDate(since.getDate() - 30);

    const recentCounts = await this.prisma.orderItem.groupBy({
      by: ['itemId'],
      where: { order: { vendorId, placedAt: { gte: since }, AND: [this.visible()] } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });
    const recentMap = new Map(recentCounts.map((rc) => [rc.itemId, rc._sum.quantity || 0]));

    return items.map((item) => ({ ...item, basePrice: Number(item.basePrice), recentOrders: recentMap.get(item.id) || 0 }));
  }

  /** How many customers came back: a repeat customer has ≥2 finished orders here;
   *  the rate is repeat/total. Finished orders only. */
  async repeatCustomers(vendorId: string) {
    const grouped = await this.prisma.order.groupBy({
      by: ['customerId'],
      where: { vendorId, status: { in: ['DELIVERED', 'COMPLETED'] }, AND: [this.visible()] },
      _count: { _all: true },
    });
    const totalCustomers = grouped.length;
    const repeatCustomers = grouped.filter((g) => g._count._all >= 2).length;
    const totalOrders = grouped.reduce((sum, g) => sum + g._count._all, 0);
    const repeatRate = totalCustomers > 0 ? Math.round((repeatCustomers / totalCustomers) * 100) : 0;
    return { totalCustomers, repeatCustomers, repeatRate, totalOrders };
  }
}
