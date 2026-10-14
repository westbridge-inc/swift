import type { PrismaClient, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { slotBlocked, slotFitsConfig, type ExceptionWindow, canonicalSlotStart } from './availability';
import { guyanaWallClockParts } from '../../utils/guyana-day';

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
// BookingService — appointment slots on SERVICE listings. The double-booking
// guarantee is the database's: a partial unique index on (itemId, slotStart)
// for non-CANCELLED rows means two concurrent reservations resolve to
// exactly one winner, no matter how the requests interleave.
// ---------------------------------------------------------------------------

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
    try {
      this.io?.to(`vendor:${vendorId}`).emit('bookings:changed', { itemId });
    } catch { /* liveness is garnish */ }
  }

  /** All slot rules except the reservation itself — checkout fails fast here.
   *  ONE availability computation: window/stride/lead-time via availability.ts
   *  and the SAME exception subtraction the picker applies — a stale picker
   *  can never book into a blocked window. */
  async validateSlot(itemId: string, requestedSlotStart: Date): Promise<BookingConfig> {
    const slotStart = canonicalSlotStart(requestedSlotStart);
    const item = await this.prisma.item.findUnique({
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

    const exceptions = await this.exceptionsFor(item.vendorId, slotStart);
    const local = guyanaWallClockParts(slotStart);
    const minutesIntoDay = local.hour * 60 + local.minute;
    if (slotBlocked(minutesIntoDay, config.durationMinutes, itemId, exceptions)) {
      // A block's existence (or reason) never leaks.
      throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
    }
    return config;
  }

  /** The vendor's exception windows for the slot's Guyana calendar date. */
  async exceptionsFor(vendorId: string, onDate: Date): Promise<ExceptionWindow[]> {
    const local = guyanaWallClockParts(onDate);
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day));
    return this.prisma.bookingException.findMany({
      where: { vendorId, date: day },
      select: { itemId: true, start: true, end: true },
    });
  }

  /**
   * Reserve a slot. Throws 409 SLOT_TAKEN when someone else got there first.
   * With an orderId (vendor acceptance), the booking is CONFIRMED directly.
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
  ) {
    slotStart = canonicalSlotStart(slotStart);
    const config = await this.validateSlot(itemId, slotStart);
    const slotEnd = new Date(slotStart.getTime() + config.durationMinutes * 60_000);

    try {
      const booking = await (db ?? this.prisma).booking.create({
        data: {
          itemId,
          customerId,
          slotStart,
          slotEnd,
          orderId,
          status: orderId ? 'CONFIRMED' : 'RESERVED',
        },
      });
      if (!db) await this.nudgeForItem(itemId);
      return booking;
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
      }
      throw error;
    }
  }

  /** [Q12] Checkout's fail-fast twin of the partial unique: a slot another
   *  booking already holds is refused when the customer asks for it — the same
   *  subtraction the picker makes — instead of a request the provider can
   *  never confirm waiting up to a day for its auto-decline. Two open requests
   *  for a FREE slot still both wait for the provider; acceptance decides. */
  async assertSlotFree(itemId: string, requestedSlotStart: Date): Promise<void> {
    const slotStart = canonicalSlotStart(requestedSlotStart);
    const held = await this.prisma.booking.findFirst({
      where: { itemId, slotStart, status: { not: 'CANCELLED' } },
      select: { id: true },
    });
    if (held) throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
  }

  /** Cancelling frees the slot (the partial unique ignores CANCELLED rows). */
  async cancelBooking(bookingId: string, customerId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking || booking.customerId !== customerId) {
      throw new NotFoundError('Booking', bookingId);
    }
    if (booking.status === 'CANCELLED') return booking;
    const cancelled = await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELLED' },
    });
    await this.nudgeForItem(booking.itemId);
    return cancelled;
  }

  /**
   * Reschedule (spec 2.4): reserve the NEW slot FIRST — the partial unique
   * guards the race — then cancel the old in the SAME transaction. Two
   * reschedules fighting for one target resolve to one winner and zero
   * orphaned or double-held slots under any interleaving; the loser's
   * original booking is untouched (the tx aborts whole).
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

    const config = await this.validateSlot(booking.itemId, newSlotStart);
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
        const created = await tx.booking.create({
          data: {
            itemId: booking.itemId,
            customerId: booking.customerId,
            orderId: booking.orderId,
            slotStart: newSlotStart,
            slotEnd,
            status: booking.status,
          },
        });
        // Guarded: if the booking died while we were validating, abort whole.
        const freed = await tx.booking.updateMany({
          where: { id: booking.id, status: { in: ['RESERVED', 'CONFIRMED'] } },
          data: { status: 'CANCELLED' },
        });
        if (freed.count !== 1) {
          throw new AppError(409, 'BOOKING_MOVED', 'This booking just changed — reload and try again');
        }
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
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
      }
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
