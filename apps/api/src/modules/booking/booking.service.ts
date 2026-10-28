import type { PrismaClient, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import {
  slotBlocked, slotFitsConfig, type ExceptionWindow, canonicalSlotStart,
  type BusyInterval, MAX_BUFFER_MINUTES, bufferOf, busyIntervalOf, candidateInterval, hasRoom,
} from './availability';
import { isBookingExclusionViolation } from './one-at-a-time';
import type { BookingLimits } from './booking-limits';
import { guyanaWallClockParts } from '../../utils/guyana-day';
import { emitToStoreRoom } from '../order/order-room-emission.service';

/** Shape stored in Item.bookingConfig for SERVICE listings. */
export interface BookingConfig {
  durationMinutes: number;
  slots: Array<{ dayOfWeek: number; start: string; end: string }>;
  /** Where the service happens: the business's place, the customer's, or
   *  the customer's choice. Absent = AT_BUSINESS (legacy listings). */
  serviceMode?: 'AT_BUSINESS' | 'MOBILE' | 'BOTH';
  serviceRadiusKm?: number;
  /** Optional gap after each booking (scheduling spec 2.5) — widens the slot
   *  grid so back-to-back never happens. Absent/0 = legacy behavior. */
  bufferMinutes?: number;
  /** Optional minimum notice — no last-second bookings. Absent/0 = legacy. */
  minNoticeMinutes?: number;
  /** [BOOK-S3 · owner A4] "Confirm bookings automatically": with INSTANT_BOOKING on, a
   *  cash booking of this listing is confirmed at checkout. Absent = the business confirms. */
  instantBooking?: boolean;
}

/** [AX289 F6] A transaction that lost a lock race: Prisma's P2034 (a write
 *  conflict or a deadlock in an interactive transaction), or PostgreSQL's
 *  40P01 (deadlock detected) / 40001 (serialization failure) surfacing from a
 *  raw statement. Exported for the unit pin. */
export function isTransactionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown };
  if (e.code === 'P2034') return true;
  if (e.meta?.code === '40P01' || e.meta?.code === '40001') return true;
  return typeof e.message === 'string' && /\b(40P01|40001)\b|deadlock detected|could not serialize access/i.test(e.message);
}

// ---------------------------------------------------------------------------
// BookingService — appointment slots on SERVICE listings.
//
// [BOOK-S1] ONE PROVIDER, ONE TIME. A booking takes the BUSINESS's time, on
// whichever listing it was made. Every writer of a business's time (reserve,
// reschedule) takes the business's advisory lock for its transaction, then
// applies the one overlap rule (availability.ts hasRoom) to every live booking
// of the business, so two concurrent reservations of overlapping times resolve
// to exactly one winner however the requests interleave. For a business that
// takes one booking at a time the database refuses an overlap as well
// (bookings_vendor_one_at_a_time, one-at-a-time.ts): a write that skips this
// service cannot double-book anyone.
// ---------------------------------------------------------------------------

/** A client the business-time reads and writes run on: the root client or a caller's transaction. */
type BookingDb = Prisma.TransactionClient | PrismaClient;

function slotTaken(): AppError {
  return new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
}

/** A write that lost the slot to another booking: the per-row uniques (P2002)
 *  or the one-at-a-time exclusion (23P01). */
function isSlotConflict(error: unknown): boolean {
  return (error as Prisma.PrismaClientKnownRequestError | null)?.code === 'P2002' || isBookingExclusionViolation(error);
}

/** [BOOK-S1] Writers of one business's time queue here, one at a time, until
 *  their transaction ends. Taken after the order row (the canonical Order →
 *  Booking lock order), never before it. The read that follows runs at READ
 *  COMMITTED (every caller's default), so it sees each booking committed by
 *  the writer it waited for. */
export async function lockBusinessTime(tx: Prisma.TransactionClient, vendorId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`booking-business:${vendorId}`}, 0))`;
}

/** [BOOK-S2] One customer's booking holds queue here, one at a time, until
 *  their transaction ends: the slot-squatting caps (booking-limits.ts) are
 *  counted and the booking written under it. Checkout takes it before the
 *  business's time lock (customer, then business), the order every holder
 *  keeps. */
export async function lockCustomerBookings(tx: Prisma.TransactionClient, customerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`booking-customer:${customerId}`}, 0))`;
}

/** [BOOK-S2] Refused in plain words when the customer already holds as many upcoming bookings as a cap allows. */
function bookingLimitReached(message: string): AppError {
  return new AppError(409, 'BOOKING_LIMIT_REACHED', message);
}

/** Who is told a cap was reached: the customer booking, or the business accepting a request. */
type LimitAudience = 'customer' | 'business';

/**
 * [BOOK-S2 · COORD 28 Oct · BOOK-S3 REVIEW-G S4-2] THE slot-squatting cap, judged under the
 * customer's booking lock (taken here, held to commit): a customer already holding
 * `limits.perBusiness` upcoming bookings with this business, or `limits.total` in all
 * (RESERVED or CONFIRMED, not yet started), takes no further booking. Checkout's hold and a
 * business accepting a request whose slot was not held at checkout both pass here, so no
 * booking is ever added outside the cap.
 */
async function assertWithinBookingLimits(
  tx: Prisma.TransactionClient,
  customerId: string,
  vendorId: string,
  limits: BookingLimits,
  audience: LimitAudience,
): Promise<void> {
  await lockCustomerBookings(tx, customerId);
  const upcoming = await tx.booking.findMany({
    where: { customerId, status: { in: ['RESERVED', 'CONFIRMED'] }, slotStart: { gt: new Date() } },
    select: { vendorId: true },
  });
  const withThisBusiness = upcoming.filter((b) => b.vendorId === vendorId).length;
  if (withThisBusiness >= limits.perBusiness) {
    throw bookingLimitReached(audience === 'customer'
      ? `You already have ${withThisBusiness} upcoming bookings with this business. Cancel one, or book again after one is done.`
      : `This customer already has ${withThisBusiness} upcoming bookings with your business, the most one customer can hold. Decline this request, or accept it after one of them is done or cancelled.`);
  }
  if (upcoming.length >= limits.total) {
    throw bookingLimitReached(audience === 'customer'
      ? `You already have ${upcoming.length} upcoming bookings. Cancel one, or book again after one is done.`
      : `This customer already has ${upcoming.length} upcoming bookings, the most one customer can hold. Decline this request, or accept it after one of them is done or cancelled.`);
  }
}

/** Parent order states in which an appointment can still be moved. */
const LIVE_APPOINTMENT_ORDER_STATUSES: ReadonlySet<string> = new Set(['PENDING', 'ACCEPTED']);
/** Parent order states that mean the appointment happened. */
const FINISHED_APPOINTMENT_ORDER_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'DELIVERED']);

export class BookingService {
  /** io is optional and never load-bearing (spec 2.6): mutations nudge the
   *  vendor room so calendars/pickers refetch instantly; the 20s poll stays
   *  the floor and the DB unique remains the only judge. */
  constructor(private prisma: PrismaClient, private io?: Server) {}

  /** Fire-and-forget liveness nudge. */
  private nudge(vendorId: string, itemId: string): void {
    // Through the store-room gate (it never throws): the current team only.
    if (this.io) void emitToStoreRoom(this.prisma, this.io, vendorId, 'bookings:changed', { itemId });
  }

  /** All slot rules except the reservation itself — checkout fails fast here.
   *  ONE availability computation: window/stride/lead-time via availability.ts
   *  and the SAME exception subtraction the picker applies — a stale picker
   *  can never book into a blocked window. */
  async validateSlot(itemId: string, requestedSlotStart: Date): Promise<BookingConfig> {
    return (await this.validatedSlot(itemId, requestedSlotStart)).config;
  }

  /** validateSlot, with the business the listing belongs to. Reads on `db`
   *  (a caller's transaction, or the root client). */
  private async validatedSlot(itemId: string, requestedSlotStart: Date, db: BookingDb = this.prisma): Promise<{ config: BookingConfig; vendorId: string }> {
    const slotStart = canonicalSlotStart(requestedSlotStart);
    const item = await db.item.findUnique({
      where: { id: itemId },
      select: { id: true, vendorId: true, fulfillment: true, bookingConfig: true, isAvailable: true },
    });
    if (!item) throw new NotFoundError('Listing', itemId);
    if (item.fulfillment !== 'APPOINTMENT' || !item.bookingConfig) {
      throw new AppError(400, 'NOT_BOOKABLE', 'This listing does not take appointments');
    }
    if (!item.isAvailable) {
      throw new AppError(400, 'UNAVAILABLE', 'This listing is currently unavailable');
    }
    if (slotStart <= new Date()) {
      throw new AppError(400, 'SLOT_IN_PAST', 'Appointments must be in the future');
    }

    const config = item.bookingConfig as unknown as BookingConfig;
    const fit = slotFitsConfig(slotStart, config, new Date());
    if (fit === 'OUTSIDE') {
      throw new AppError(400, 'SLOT_OUTSIDE_HOURS', 'That time is not offered for this service');
    }
    if (fit === 'TOO_SOON') {
      throw new AppError(400, 'SLOT_TOO_SOON', 'That time is too soon to book — pick a later slot');
    }

    const exceptions = await this.exceptionsFor(item.vendorId, slotStart, db);
    const local = guyanaWallClockParts(slotStart);
    const minutesIntoDay = local.hour * 60 + local.minute;
    if (slotBlocked(minutesIntoDay, config.durationMinutes, itemId, exceptions)) {
      // A block's existence (or reason) never leaks.
      throw slotTaken();
    }
    return { config, vendorId: item.vendorId };
  }

  /** [BOOK-S1] The business's time held by its live bookings (every listing)
   *  that can reach [from, to), and how many it serves at once. A booking's
   *  held time runs past its end by its listing's gap, so the read reaches back
   *  by the longest gap a listing may set. */
  async businessTime(
    vendorId: string,
    from: Date,
    to: Date,
    db: BookingDb = this.prisma,
  ): Promise<{ busy: BusyInterval[]; capacity: number }> {
    const rows = await db.booking.findMany({
      where: {
        vendorId,
        status: { not: 'CANCELLED' },
        slotStart: { lt: to },
        slotEnd: { gt: new Date(from.getTime() - MAX_BUFFER_MINUTES * 60_000) },
      },
      select: { slotStart: true, slotEnd: true, item: { select: { bookingConfig: true } } },
    });
    const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { bookingCapacity: true } });
    const busy = rows
      .map((r) => busyIntervalOf(r.slotStart, r.slotEnd, bufferOf(r.item.bookingConfig)))
      .filter((b) => b.start < to && b.end > from);
    return { busy, capacity: vendor?.bookingCapacity ?? 1 };
  }

  /** [BOOK-S1] THE overlap rule at a write or at checkout: refuse the slot
   *  unless the business has room for it. Returns the capacity it judged by. */
  private async assertRoom(db: BookingDb, vendorId: string, slotStart: Date, config: BookingConfig): Promise<number> {
    const span = candidateInterval(slotStart, config);
    const { busy, capacity } = await this.businessTime(vendorId, span.start, span.end, db);
    if (!hasRoom(span, busy, capacity)) throw slotTaken();
    return capacity;
  }

  /** The vendor's exception windows for the slot's Guyana calendar date. */
  async exceptionsFor(vendorId: string, onDate: Date, db: BookingDb = this.prisma): Promise<ExceptionWindow[]> {
    const local = guyanaWallClockParts(onDate);
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day));
    return db.bookingException.findMany({
      where: { vendorId, date: day },
      select: { itemId: true, start: true, end: true },
    });
  }

  /**
   * Reserve a slot. Throws 409 SLOT_TAKEN when someone else got there first.
   * With an orderId (vendor acceptance), the booking is CONFIRMED directly.
   * [BOOK-S2] An order that already holds its slot (taken at checkout while
   * INSTANT_BOOKING was on) is not reserved twice: its booking is returned as
   * it is. The acceptance's own transition confirmed it, earlier in this same
   * commit, through the one coupling seam (booking/order-coupling.ts).
   * [BOOK-S3 · REVIEW-G S4-2 on #2192] With `limits` (INSTANT_BOOKING on), an
   * order whose slot was NOT held at checkout (a request placed while the
   * switch was off, accepted after it was switched on) takes its booking under
   * the same per-customer cap as checkout: never one over it.
   */
  /** [REPORT-007-v4 F-05] Accepts a transaction client so appointment
   *  acceptance can reserve its slot INSIDE the canonical Order-lock commit —
   *  the old pre-transaction reservation could leave Order=CANCELLED with a
   *  freshly-minted CONFIRMED slot-blocking booking when acceptance lost the
   *  race to a cancellation. When a tx is supplied the nudge is skipped
   *  (publications never ride a transaction); callers nudge after commit. */
  async reserveSlot(
    itemId: string,
    customerId: string,
    slotStart: Date,
    orderId?: string,
    db?: Prisma.TransactionClient,
    limits?: BookingLimits,
  ) {
    slotStart = canonicalSlotStart(slotStart);
    const { config, vendorId } = await this.validatedSlot(itemId, slotStart);

    const write = async (tx: Prisma.TransactionClient) => {
      if (orderId) {
        const held = await tx.booking.findFirst({ where: { orderId, status: { in: ['RESERVED', 'CONFIRMED'] } } });
        if (held) return held;
      }
      if (limits) await assertWithinBookingLimits(tx, customerId, vendorId, limits, 'business');
      return this.writeBooking(tx, { itemId, vendorId, customerId, slotStart, config, orderId, status: orderId ? 'CONFIRMED' : 'RESERVED' });
    };
    try {
      const booking = db ? await write(db) : await this.prisma.$transaction(write);
      if (!db) await this.nudgeForItem(itemId);
      return booking;
    } catch (error) {
      if (isSlotConflict(error)) throw slotTaken();
      throw error;
    }
  }

  /**
   * [BOOK-S2 · INSTANT_BOOKING] Take the slot for an order being placed, INSIDE
   * the checkout transaction: the booking is RESERVED and linked to the order,
   * judged under the business's lock against every live booking of the
   * business. A lost race throws 409 SLOT_TAKEN, which rolls the whole
   * checkout back: no order, no payment instruction. The caller nudges the
   * business's calendars after its commit.
   * [COORD ruling 28 Oct · slot squatting] Under the customer's booking lock,
   * a customer already holding `limits.perBusiness` upcoming bookings with
   * this business, or `limits.total` in all, is refused (409
   * BOOKING_LIMIT_REACHED), so a customer can never hold a business's time
   * without limit before paying anything.
   */
  async holdSlotAtCheckout(
    tx: Prisma.TransactionClient,
    input: { itemId: string; customerId: string; slotStart: Date; orderId: string; limits: BookingLimits },
  ) {
    const slotStart = canonicalSlotStart(input.slotStart);
    // On the checkout's own transaction: no second connection while it holds the locks.
    const { config, vendorId } = await this.validatedSlot(input.itemId, slotStart, tx);
    await assertWithinBookingLimits(tx, input.customerId, vendorId, input.limits, 'customer');
    try {
      return await this.writeBooking(tx, { itemId: input.itemId, customerId: input.customerId, orderId: input.orderId, vendorId, slotStart, config, status: 'RESERVED' });
    } catch (error) {
      if (isSlotConflict(error)) throw slotTaken();
      throw error;
    }
  }

  /** [BOOK-S1] The one booking write: under the business's lock, every live
   *  booking of the business, on any listing, is judged before the row is
   *  written. */
  private async writeBooking(
    tx: Prisma.TransactionClient,
    b: { itemId: string; vendorId: string; customerId: string; slotStart: Date; config: BookingConfig; orderId?: string; status: 'RESERVED' | 'CONFIRMED' },
  ) {
    await lockBusinessTime(tx, b.vendorId);
    const capacity = await this.assertRoom(tx, b.vendorId, b.slotStart, b.config);
    return tx.booking.create({
      data: {
        itemId: b.itemId,
        vendorId: b.vendorId,
        customerId: b.customerId,
        slotStart: b.slotStart,
        slotEnd: new Date(b.slotStart.getTime() + b.config.durationMinutes * 60_000),
        orderId: b.orderId,
        status: b.status,
        exclusive: capacity <= 1,
      },
    });
  }

  /** [Q12] Checkout's fail-fast twin of the reservation's rule: a slot another
   *  booking already holds is refused when the customer asks for it — the same
   *  subtraction the picker makes — instead of a request the provider can
   *  never confirm waiting up to a day for its auto-decline. While
   *  INSTANT_BOOKING is off, two open requests for a FREE slot still both wait
   *  for the provider and acceptance decides; with it on, checkout takes the
   *  slot itself (holdSlotAtCheckout) and this stays the friendly fast fail. */
  async assertSlotFree(itemId: string, requestedSlotStart: Date): Promise<void> {
    const slotStart = canonicalSlotStart(requestedSlotStart);
    // [BOOK-S1] The business's time, not the listing's: a time another listing
    // of the business holds is refused here too.
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { vendorId: true, bookingConfig: true } });
    if (!item?.bookingConfig) throw new NotFoundError('Listing', itemId);
    await this.assertRoom(this.prisma, item.vendorId, slotStart, item.bookingConfig as unknown as BookingConfig);
  }

  /**
   * Reschedule (spec 2.4): in ONE transaction, under the order's lock and then
   * the business's [BOOK-S1], free the old slot, judge the new one against
   * every other live booking of the business, and write it. Two reschedules
   * fighting for one target resolve to one winner and zero orphaned or
   * double-held slots under any interleaving; the loser's original booking is
   * untouched (the tx aborts whole). Freeing first lets a booking move to a
   * time that overlaps its own old one.
   */
  async rescheduleBooking(
    bookingId: string,
    newSlotStart: Date,
    actor: { customerId?: string; vendorId?: string },
  ) {
    newSlotStart = canonicalSlotStart(newSlotStart);
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { item: { select: { id: true, vendorId: true, name: true } } },
    });
    if (!booking) throw new NotFoundError('Booking', bookingId);
    const owned =
      (actor.customerId && booking.customerId === actor.customerId) ||
      (actor.vendorId && booking.item.vendorId === actor.vendorId);
    if (!owned) throw new NotFoundError('Booking', bookingId);
    if (booking.status !== 'RESERVED' && booking.status !== 'CONFIRMED') {
      throw new AppError(400, 'NOT_RESCHEDULABLE', `This booking is ${booking.status.toLowerCase()} and cannot be moved`);
    }
    if (booking.slotStart.getTime() === newSlotStart.getTime()) return { booking, moved: false as const };

    const { config, vendorId } = await this.validatedSlot(booking.itemId, newSlotStart);
    const slotEnd = new Date(newSlotStart.getTime() + config.durationMinutes * 60_000);
    try {
      const next = await this.prisma.$transaction(async (tx) => {
        // [AX289 F6] The canonical lock order is Order → Booking: the
        // cancellation, the acceptance and every order transition take the
        // order row first, then its bookings. A reschedule that wrote its
        // bookings first and the order last could deadlock against a
        // cancellation of the same order, so it waits on the order row BEFORE
        // it touches a booking; the guarded write below then sees whatever
        // that cancellation committed.
        if (booking.orderId) {
          await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${booking.orderId} FOR UPDATE`;
          // [L09 · M018] A finished appointment is not reopened by moving its
          // booking: read the parent under its own lock and refuse.
          const parent = await tx.order.findUniqueOrThrow({ where: { id: booking.orderId }, select: { status: true } });
          if (FINISHED_APPOINTMENT_ORDER_STATUSES.has(parent.status)) {
            throw new AppError(400, 'NOT_RESCHEDULABLE', 'This appointment is completed and cannot be moved');
          }
          // A cancellation (or any other exit) committed while we waited on
          // the lock: the same answer the lost race has always had.
          if (!LIVE_APPOINTMENT_ORDER_STATUSES.has(parent.status)) {
            throw new AppError(409, 'BOOKING_MOVED', 'This booking just changed — reload and try again');
          }
        }
        await lockBusinessTime(tx, vendorId);
        // Guarded: if the booking died while we were validating, abort whole.
        const freed = await tx.booking.updateMany({
          where: { id: booking.id, status: { in: ['RESERVED', 'CONFIRMED'] } },
          data: { status: 'CANCELLED' },
        });
        if (freed.count !== 1) {
          throw new AppError(409, 'BOOKING_MOVED', 'This booking just changed — reload and try again');
        }
        const capacity = await this.assertRoom(tx, vendorId, newSlotStart, config);
        const created = await tx.booking.create({
          data: {
            itemId: booking.itemId,
            vendorId,
            customerId: booking.customerId,
            orderId: booking.orderId,
            slotStart: newSlotStart,
            slotEnd,
            status: booking.status,
            exclusive: capacity <= 1,
          },
        });
        // [Q12] The ORDER carries the time every surface shows: the customer
        // order screen and home card, the provider board and detail, admin.
        // Moving only the booking left all of them on the old time while the
        // provider calendar and the reminder moved: two answers to "when".
        if (booking.orderId) {
          await tx.order.update({ where: { id: booking.orderId }, data: { appointmentSlot: newSlotStart } });
        }
        return created;
      });
      await this.nudgeForItem(booking.itemId);
      return { booking: next, moved: true as const, previousSlotStart: booking.slotStart, serviceName: booking.item.name };
    } catch (error) {
      if (isSlotConflict(error)) throw slotTaken();
      // [AX289 F6] A deadlock or serialization failure is a race this move
      // lost, not a server fault: the customer reloads and tries again.
      if (isTransactionConflict(error)) {
        throw new AppError(409, 'BOOKING_MOVED', 'This booking just changed — reload and try again');
      }
      throw error;
    }
  }

  /** Public: transactional reserveSlot callers nudge AFTER their commit —
   *  publications never ride a transaction [REPORT-007-v4 F-05]. */
  async nudgeForItem(itemId: string): Promise<void> {
    if (!this.io) return;
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { vendorId: true } });
    if (item) this.nudge(item.vendorId, itemId);
  }
}
