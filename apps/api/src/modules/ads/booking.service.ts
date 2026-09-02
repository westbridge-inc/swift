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

export interface AvailabilityWeek {
  weekStart: string;
  capacity: number;
  booked: number;
  available: number;
  price: number;
}

/** [R045-ADS-04 · 05 · 06] The campaign aggregate lock: checkout, the hold,
 *  payment confirmation and expiry all take it, so they serialize. */
export async function lockCampaign(tx: Prisma.TransactionClient, campaignId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "ad_campaigns" WHERE "id" = ${campaignId} FOR UPDATE`;
}

/** Test seam: runs inside reserveAndHold's transaction after the campaign
 *  lock is held, so a proof can start a second checkout and watch it wait.
 *  Never set in routes. */
export interface BookingObserver {
  afterLock?: (campaignId: string) => Promise<void>;
}

export class BookingService {
  observer: BookingObserver = {};
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
    return this.reserveAndHold(campaignId, opts);
  }

  /** [R045-ADS-04 · 06] The campaign aggregate is locked (FOR UPDATE on the
   *  campaign row) and the reservation and the campaign's status commit
   *  together: a DRAFT campaign can never be left holding RESERVED inventory
   *  because the second write failed, and two concurrent holds serialize. */
  async reserveAndHold(campaignId: string, opts: { reservationMinutes?: number; within?: (tx: Prisma.TransactionClient) => Promise<void> } = {}): Promise<{ bookings: number; total: number }> {
    const head = await this.prisma.adCampaign.findUnique({ where: { id: campaignId }, include: { placement: true } });
    if (!head) throw new NotFoundError('AdCampaign', campaignId);
    // Ensure every target row exists BEFORE the locking transaction, so the
    // FOR UPDATE always has a row to lock (create-races settle here, not under
    // the lock).
    for (const city of head.cities.length > 0 ? head.cities : ['*']) {
      for (const weekStart of weeksBetween(head.startWeek, head.endWeek)) {
        await this.ensureWeek(this.prisma, head.placement.id, city, weekStart, head.placement.slotsPerWeek);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      await lockCampaign(tx, campaignId);
      await this.observer.afterLock?.(campaignId);
      const campaign = await tx.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { placement: true } });
      if (campaign.status !== 'DRAFT' && campaign.status !== 'PENDING_PAYMENT') {
        throw new AppError(409, 'CAMPAIGN_NOT_BOOKABLE', `A ${campaign.status} campaign cannot reserve inventory.`);
      }
      const result = await this.reserveWithin(tx, campaign, opts.reservationMinutes ?? 20);
      const moved = await tx.adCampaign.updateMany({ where: { id: campaignId, status: { in: ['DRAFT', 'PENDING_PAYMENT'] } }, data: { status: 'PENDING_PAYMENT', totalAmount: result.total } });
      if (moved.count !== 1) throw new AppError(409, 'CAMPAIGN_TRANSITION_RACE', 'The campaign changed underneath the reservation — retry.');
      if (opts.within) await opts.within(tx);
      return result;
    });
  }

  /** The race-safe core, inside the caller's transaction: a FOR UPDATE lock
   *  per (placement, city, week); all-or-nothing. A campaign that already holds
   *  its inventory (a second checkout) reserves nothing and reports its total. */
  async reserveWithin(tx: Prisma.TransactionClient, campaign: { id: string; startWeek: Date; endWeek: Date; cities: string[]; placement: { id: string; weeklyPrice: Prisma.Decimal; slotsPerWeek: number } }, reservationMinutes: number): Promise<{ bookings: number; total: number }> {
    const placement = campaign.placement;
    const weeks = weeksBetween(campaign.startWeek, campaign.endWeek);
    const cities = campaign.cities.length > 0 ? campaign.cities : ['*'];
    const price = placement.weeklyPrice;
    const total = Number(price) * weeks.length * cities.length;
    const held = await tx.adBooking.count({ where: { campaignId: campaign.id, status: { in: ['RESERVED', 'CONFIRMED'] } } });
    if (held > 0) return { bookings: 0, total };
    const reservedUntil = new Date(Date.now() + reservationMinutes * 60_000);
    let created = 0;
    for (const city of cities) {
      for (const weekStart of weeks) {
        // Row lock — the serialization point. A concurrent reserve blocks
        // here until we commit, then re-reads the incremented `booked`.
        const rows = await tx.$queryRaw<Array<{ id: string; booked: number; capacity: number }>>(
          Prisma.sql`SELECT "id", "booked", "capacity" FROM "ad_inventory_weeks"
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
    return { bookings: created, total };
  }

  /** §16 "reservation expiring" feed: RESERVED holds whose TTL lapses within
   *  `withinMinutes` — one row per campaign with its soonest deadline, so the
   *  advertiser gets ONE "5 minutes left, finish payment" warning, not one per
   *  booked week. The caller dedupes across cron ticks (redis once-key). */
  async expiringSoon(withinMinutes: number, now = new Date()): Promise<Array<{ campaignId: string; advertiserId: string; reservedUntil: Date }>> {
    const soon = new Date(now.getTime() + withinMinutes * 60_000);
    const rows = await this.prisma.adBooking.findMany({
      where: { status: 'RESERVED', reservedUntil: { gt: now, lte: soon } },
      select: { campaignId: true, reservedUntil: true, campaign: { select: { advertiserId: true } } },
      take: 500,
    });
    const byCampaign = new Map<string, { campaignId: string; advertiserId: string; reservedUntil: Date }>();
    for (const r of rows) {
      if (!r.reservedUntil) continue;
      const cur = byCampaign.get(r.campaignId);
      if (!cur || r.reservedUntil < cur.reservedUntil) {
        byCampaign.set(r.campaignId, { campaignId: r.campaignId, advertiserId: r.campaign.advertiserId, reservedUntil: r.reservedUntil });
      }
    }
    return [...byCampaign.values()];
  }

  /** §7.3 cron (every minute) — expired RESERVED holds go RELEASED and give the
   *  inventory back. Each release is CAS + guarded decrement, so the sweep is
   *  idempotent and overlap-safe. */
  async releaseExpired(now = new Date()): Promise<{ released: number; voided: number }> {
    const expired = await this.prisma.adBooking.findMany({
      where: { status: 'RESERVED', reservedUntil: { lt: now } },
      select: { id: true, campaignId: true },
      take: 500,
    });
    let released = 0;
    let voided = 0;
    // [R045-ADS-05] Per campaign, ONE transaction under the campaign lock —
    // the same lock payment confirmation takes — so expiry and confirmation
    // serialize: the result is paid with confirmed inventory, or expired with
    // the campaign back in DRAFT and its open invoice VOID. Never a hybrid.
    for (const campaignId of new Set(expired.map((b) => b.campaignId))) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await lockCampaign(tx, campaignId);
        const holds = await tx.adBooking.findMany({ where: { campaignId, status: 'RESERVED', reservedUntil: { lt: now } }, select: { id: true, placementId: true, city: true, weekStart: true } });
        let releasedHere = 0;
        for (const b of holds) {
          const moved = await tx.adBooking.updateMany({ where: { id: b.id, status: 'RESERVED' }, data: { status: 'RELEASED' } });
          if (moved.count === 0) continue; // confirmed under the lock before us
          // Give the slot back — guarded so booked never goes negative.
          await tx.adInventoryWeek.updateMany({ where: { placementId: b.placementId, city: b.city, weekStart: b.weekStart, booked: { gt: 0 } }, data: { booked: { decrement: 1 } } });
          releasedHere += 1;
        }
        // §6.1 reservation_expired: a PENDING_PAYMENT campaign that just lost
        // its last hold goes back to DRAFT and its open invoice is VOIDed —
        // never a campaign holding nothing, never an invoice for released inventory.
        let voidedHere = 0;
        const stillHeld = await tx.adBooking.count({ where: { campaignId, status: 'RESERVED' } });
        if (stillHeld === 0) {
          const moved = await tx.adCampaign.updateMany({ where: { id: campaignId, status: 'PENDING_PAYMENT' }, data: { status: 'DRAFT', statusReason: 'Reservation hold expired before payment' } });
          if (moved.count === 1) {
            await tx.adInvoice.updateMany({ where: { campaignId, status: 'UNPAID' }, data: { status: 'VOID' } });
            voidedHere = 1;
          }
        }
        return { releasedHere, voidedHere };
      });
      released += outcome.releasedHere;
      voided += outcome.voidedHere;
    }

    if (released > 0) log().info({ released, voided }, 'ads: expired reservations released');
    return { released, voided };
  }
}
