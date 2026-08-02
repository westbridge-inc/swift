import type { PrismaClient } from '@prisma/client';
import { mondayOfDate } from './ads-weeks';

// Operator revenue + inventory reads (ads-platform spec §15.3/§15.8). The
// dashboards law applies: every figure here is computed from the same rows
// money actually moved on (bookings + invoices), and the reconciliation
// merge-gate test proves booked revenue ties to paid invoices exactly.
// Booked vs recognized (§8.5) are BOTH shown, never conflated: booked =
// confirmed bookings; recognized = weeklyPrice/7 per elapsed live day.

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RevenueWeekRow {
  weekStart: string;
  placementId: string;
  placementKey: string;
  placementName: string;
  bookedGross: number;
  refunded: number;
  bookedNet: number;
  recognized: number;
  capacity: number;
  bookedSlots: number;
  fillRate: number;
}

export class AdsRevenueService {
  constructor(private prisma: PrismaClient) {}

  /** §15.8 — booked vs recognized by week × placement, fill rate, advertiser
   *  count, and the invoice reconciliation block. `now` injectable for tests. */
  async dashboard(tenantId: string, from: Date, to: Date, now: Date = new Date()) {
    const [bookings, inventory, placements] = await Promise.all([
      this.prisma.adBooking.findMany({
        where: { weekStart: { gte: from, lte: to }, status: { in: ['CONFIRMED', 'REFUNDED'] }, campaign: { tenantId } },
        select: { campaignId: true, placementId: true, weekStart: true, amount: true, status: true, campaign: { select: { advertiserId: true } } },
      }),
      this.prisma.adInventoryWeek.findMany({
        where: { weekStart: { gte: from, lte: to }, placement: { tenantId } },
        select: { placementId: true, weekStart: true, capacity: true, booked: true },
      }),
      this.prisma.adPlacement.findMany({ where: { tenantId }, select: { id: true, key: true, name: true } }),
    ]);
    const placementById = new Map(placements.map((p) => [p.id, p]));

    // One row per (week, placement). Recognized (§8.5) = amount/7 per elapsed
    // full day of a CONFIRMED week, clamped 0..7; refunded weeks recognize 0.
    const rows = new Map<string, RevenueWeekRow>();
    const rowFor = (placementId: string, weekStart: Date): RevenueWeekRow => {
      const key = `${weekStart.toISOString().slice(0, 10)}|${placementId}`;
      let r = rows.get(key);
      if (!r) {
        const p = placementById.get(placementId);
        r = {
          weekStart: weekStart.toISOString().slice(0, 10),
          placementId,
          placementKey: p?.key ?? placementId,
          placementName: p?.name ?? placementId,
          bookedGross: 0, refunded: 0, bookedNet: 0, recognized: 0,
          capacity: 0, bookedSlots: 0, fillRate: 0,
        };
        rows.set(key, r);
      }
      return r;
    };

    const advertiserIds = new Set<string>();
    for (const b of bookings) {
      const r = rowFor(b.placementId, b.weekStart);
      const amount = Number(b.amount);
      r.bookedGross = round2(r.bookedGross + amount);
      advertiserIds.add(b.campaign.advertiserId);
      if (b.status === 'REFUNDED') {
        r.refunded = round2(r.refunded + amount);
      } else {
        const elapsedDays = Math.min(7, Math.max(0, Math.floor((now.getTime() - b.weekStart.getTime()) / DAY_MS)));
        r.recognized = round2(r.recognized + (amount / 7) * elapsedDays);
      }
      r.bookedNet = round2(r.bookedGross - r.refunded);
    }
    for (const inv of inventory) {
      const r = rowFor(inv.placementId, inv.weekStart);
      r.capacity += inv.capacity;
      r.bookedSlots += inv.booked;
      r.fillRate = r.capacity > 0 ? Math.round((r.bookedSlots / r.capacity) * 10000) / 10000 : 0;
    }

    const weeks = [...rows.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart) || a.placementKey.localeCompare(b.placementKey));
    const totals = weeks.reduce(
      (t, r) => ({
        bookedGross: round2(t.bookedGross + r.bookedGross),
        refunded: round2(t.refunded + r.refunded),
        bookedNet: round2(t.bookedNet + r.bookedNet),
        recognized: round2(t.recognized + r.recognized),
      }),
      { bookedGross: 0, refunded: 0, bookedNet: 0, recognized: 0 },
    );

    return {
      weeks,
      totals: { ...totals, advertiserCount: advertiserIds.size },
      reconciliation: await this.reconcile([...new Set(bookings.map((b) => b.campaignId))]),
    };
  }

  /** The tie-out (dashboards law / acceptance #11): for every campaign with a
   *  sold booking in range, the sum of ALL its sold bookings must equal the
   *  sum of its PAID invoices — checkout writes one invoice covering exactly
   *  the booked weeks, and refunds change statuses/refundedAmount, never the
   *  invoice amount. Whole campaigns (not range-clipped rows) so the tie is
   *  exact for any query range. A nonzero delta is data drift — surface loud. */
  private async reconcile(campaignIds: string[]) {
    if (campaignIds.length === 0) return { bookedAllCampaigns: 0, invoicedPaid: 0, invoiceRefunded: 0, delta: 0 };
    const [allBookings, invoices] = await Promise.all([
      this.prisma.adBooking.findMany({
        where: { campaignId: { in: campaignIds }, status: { in: ['CONFIRMED', 'REFUNDED'] } },
        select: { amount: true },
      }),
      this.prisma.adInvoice.findMany({
        where: { campaignId: { in: campaignIds }, paidAt: { not: null } },
        select: { amount: true, refundedAmount: true },
      }),
    ]);
    const bookedAllCampaigns = round2(allBookings.reduce((s, b) => s + Number(b.amount), 0));
    const invoicedPaid = round2(invoices.reduce((s, i) => s + Number(i.amount), 0));
    const invoiceRefunded = round2(invoices.reduce((s, i) => s + Number(i.refundedAmount), 0));
    return { bookedAllCampaigns, invoicedPaid, invoiceRefunded, delta: round2(bookedAllCampaigns - invoicedPaid) };
  }

  /** §15.3 — placements × next N weeks occupancy grid, per city, with
   *  click-through campaign ids. Inventory rows are lazily materialised, so a
   *  missing row means an untouched week: full capacity (slotsPerWeek), no
   *  bookings. RESERVED holds are shown as occupancy-in-flight. */
  async inventoryCalendar(tenantId: string, weeksAhead = 12, start: Date = mondayOfDate(new Date())) {
    const end = new Date(start.getTime() + (weeksAhead - 1) * 7 * DAY_MS);
    const [placements, inventory, bookings] = await Promise.all([
      this.prisma.adPlacement.findMany({ where: { tenantId, active: true }, orderBy: { tier: 'asc' }, select: { id: true, key: true, name: true, tier: true, slotsPerWeek: true, weeklyPrice: true } }),
      this.prisma.adInventoryWeek.findMany({
        where: { weekStart: { gte: start, lte: end }, placement: { tenantId } },
        select: { placementId: true, city: true, weekStart: true, capacity: true, booked: true },
      }),
      this.prisma.adBooking.findMany({
        where: { weekStart: { gte: start, lte: end }, status: { in: ['RESERVED', 'CONFIRMED'] }, campaign: { tenantId } },
        select: { placementId: true, city: true, weekStart: true, status: true, campaign: { select: { id: true, name: true, status: true, advertiser: { select: { companyName: true } } } } },
      }),
    ]);

    const weekStarts = Array.from({ length: weeksAhead }, (_, i) => new Date(start.getTime() + i * 7 * DAY_MS).toISOString().slice(0, 10));
    const invByKey = new Map(inventory.map((r) => [`${r.placementId}|${r.city}|${r.weekStart.toISOString().slice(0, 10)}`, r]));
    const bookingsByKey = new Map<string, typeof bookings>();
    for (const b of bookings) {
      const key = `${b.placementId}|${b.city}|${b.weekStart.toISOString().slice(0, 10)}`;
      const list = bookingsByKey.get(key) ?? [];
      list.push(b);
      bookingsByKey.set(key, list);
    }
    // Cities that have ever been touched for a placement (plus "*" always).
    const citiesByPlacement = new Map<string, Set<string>>();
    for (const r of [...inventory, ...bookings]) {
      const set = citiesByPlacement.get(r.placementId) ?? new Set<string>();
      set.add(r.city);
      citiesByPlacement.set(r.placementId, set);
    }

    return {
      weekStarts,
      placements: placements.map((p) => {
        const cities = [...(citiesByPlacement.get(p.id) ?? new Set(['*']))].sort();
        return {
          id: p.id, key: p.key, name: p.name, tier: p.tier, weeklyPrice: Number(p.weeklyPrice),
          cities: cities.map((city) => ({
            city,
            weeks: weekStarts.map((week) => {
              const inv = invByKey.get(`${p.id}|${city}|${week}`);
              const cellBookings = bookingsByKey.get(`${p.id}|${city}|${week}`) ?? [];
              return {
                weekStart: week,
                capacity: inv?.capacity ?? p.slotsPerWeek,
                booked: inv?.booked ?? 0,
                campaigns: cellBookings.map((b) => ({
                  id: b.campaign.id, name: b.campaign.name, status: b.campaign.status,
                  advertiser: b.campaign.advertiser.companyName, bookingStatus: b.status,
                })),
              };
            }),
          })),
        };
      }),
    };
  }
}
