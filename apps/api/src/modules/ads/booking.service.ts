import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { mondayOfDate, weeksBetween, isMonday } from './ads-weeks';

// Inventory & booking engine (ads-platform spec §7). The reservation is the
// race-safe core: a single interactive transaction takes a FOR UPDATE row lock
// on each AdInventoryWeek — the ONLY way booked is ever changed — so N parallel
// checkouts against a capacity-1 week yield exactly ONE reservation (§7.4, a
// merge gate). All-or-nothing: any unavailable slot rolls the whole booking
// back and names the exact city+week that failed. Price is copied onto each
// booking row, so a later placement price change never touches existing books.

export class SlotUnavailableError extends AppError {
  constructor(public city: string, public weekStart: Date) {
    super(409, 'SLOT_UNAVAILABLE', `That slot is already taken: ${city} / week of ${weekStart.toISOString().slice(0, 10)}.`);
  }
}

const INV_TABLE = Prisma.raw('"ad_inventory_weeks"');

export interface AvailabilityWeek {
  weekStart: string;
  capacity: number;
  booked: number;
  available: number;
  price: number;
}

export class BookingService {
  constructor(private prisma: PrismaClient) {}

  /** §7.2 — ensure the inventory row exists (capacity = placement.slotsPerWeek).
   *  Idempotent under concurrency: a losing INSERT (P2002) means a peer created
   *  it first, which is fine. The reservation path calls this before locking so
   *  FOR UPDATE always has a row; availability calls it so both see identical
   *  rows. Accepts an optional tx so it can run inside the reservation txn. */
  async ensureWeek(
    db: Pick<PrismaClient, 'adInventoryWeek'>,
    placementId: string,
    city: string,
    weekStart: Date,
    capacity: number,
  ): Promise<void> {
    if (!isMonday(weekStart)) throw new AppError(400, 'NOT_A_MONDAY', 'Ad weeks must start on a Monday.');
    try {
      await db.adInventoryWeek.create({ data: { placementId, city, weekStart, capacity, booked: 0 } });
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code !== 'P2002') throw err; // already exists — fine
    }
  }

  /** §7.2 availability read — per week for one city, lazily materialising rows. */
  async availability(placementId: string, city: string, from: Date, to: Date): Promise<AvailabilityWeek[]> {
    const placement = await this.prisma.adPlacement.findUnique({ where: { id: placementId } });
    if (!placement) throw new NotFoundError('AdPlacement', placementId);
    const weeks = weeksBetween(mondayOfDate(from), mondayOfDate(to));
    const out: AvailabilityWeek[] = [];
    for (const weekStart of weeks) {
      await this.ensureWeek(this.prisma, placementId, city, weekStart, placement.slotsPerWeek);
      const inv = await this.prisma.adInventoryWeek.findUniqueOrThrow({
        where: { placementId_city_weekStart: { placementId, city, weekStart } },
      });
      out.push({
        weekStart: weekStart.toISOString().slice(0, 10),
        capacity: inv.capacity,
        booked: inv.booked,
        available: Math.max(0, inv.capacity - inv.booked),
        price: Number(placement.weeklyPrice),
      });
    }
    return out;
  }

  /** §7.3 reserve — the race-safe core. One interactive transaction; a
   *  FOR UPDATE lock per (placement, city, week); all-or-nothing. Returns the
   *  created RESERVED bookings. `reservationMinutes` sets the hold TTL. */
  async reserve(campaignId: string, opts: { reservationMinutes?: number } = {}): Promise<{ bookings: number; total: number }> {
    const campaign = await this.prisma.adCampaign.findUnique({
      where: { id: campaignId },
      include: { placement: true },
    });
    if (!campaign) throw new NotFoundError('AdCampaign', campaignId);
    if (campaign.status !== 'DRAFT' && campaign.status !== 'PENDING_PAYMENT') {
      throw new AppError(409, 'CAMPAIGN_NOT_BOOKABLE', `A ${campaign.status} campaign cannot reserve inventory.`);
    }
    const placement = campaign.placement;
    const weeks = weeksBetween(campaign.startWeek, campaign.endWeek);
    const cities = campaign.cities.length > 0 ? campaign.cities : ['*'];
    const reservationMinutes = opts.reservationMinutes ?? 20;
    const price = placement.weeklyPrice;

    // Ensure every target row exists BEFORE the locking transaction, so the
    // FOR UPDATE always has a row to lock (create-races settle here, not under
    // the lock).
    for (const city of cities) {
      for (const weekStart of weeks) {
        await this.ensureWeek(this.prisma, placement.id, city, weekStart, placement.slotsPerWeek);
      }
    }

    const reservedUntil = new Date(Date.now() + reservationMinutes * 60_000);
    let created = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const city of cities) {
        for (const weekStart of weeks) {
          // Row lock — the serialization point. A concurrent reserve blocks
          // here until we commit, then re-reads the incremented `booked`.
          const rows = await tx.$queryRaw<Array<{ id: string; booked: number; capacity: number }>>(
            Prisma.sql`SELECT "id", "booked", "capacity" FROM ${INV_TABLE}
                       WHERE "placementId" = ${placement.id} AND "city" = ${city} AND "weekStart" = ${weekStart}::date
                       FOR UPDATE`,
          );
          const inv = rows[0];
          if (!inv || inv.booked >= inv.capacity) throw new SlotUnavailableError(city, weekStart);
          await tx.adInventoryWeek.update({ where: { id: inv.id }, data: { booked: { increment: 1 } } });
          await tx.adBooking.create({
            data: { campaignId: campaign.id, placementId: placement.id, city, weekStart, amount: price, status: 'RESERVED', reservedUntil },
          });
          created += 1;
        }
      }
    });

    const total = Number(price) * weeks.length * cities.length;
    return { bookings: created, total };
  }

  /** §7.3 cron (every minute) — expired RESERVED holds go RELEASED and give the
   *  inventory back. Each release is CAS + guarded decrement, so the sweep is
   *  idempotent and overlap-safe. */
  async releaseExpired(now = new Date()): Promise<{ released: number }> {
    const expired = await this.prisma.adBooking.findMany({
      where: { status: 'RESERVED', reservedUntil: { lt: now } },
      select: { id: true, placementId: true, city: true, weekStart: true },
      take: 500,
    });
    let released = 0;
    for (const b of expired) {
      const moved = await this.prisma.adBooking.updateMany({
        where: { id: b.id, status: 'RESERVED' },
        data: { status: 'RELEASED' },
      });
      if (moved.count === 0) continue; // a peer released it, or it got confirmed
      // Give the slot back — guarded so booked never goes negative.
      await this.prisma.adInventoryWeek.updateMany({
        where: { placementId: b.placementId, city: b.city, weekStart: b.weekStart, booked: { gt: 0 } },
        data: { booked: { decrement: 1 } },
      });
      released += 1;
    }
    if (released > 0) log().info({ released }, 'ads: expired reservations released');
    return { released };
  }
}
