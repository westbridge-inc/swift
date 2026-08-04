import type { PrismaClient, Prisma } from '@prisma/client';
import type { Server } from 'socket.io';
import { AppError, NotFoundError } from '../../utils/errors';
import { slotBlocked, slotFitsConfig, type ExceptionWindow } from './availability';

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

// ---------------------------------------------------------------------------
// BookingService — appointment slots on SERVICE listings. The double-booking
// guarantee is the database's: a partial unique index on (itemId, slotStart)
// for non-CANCELLED rows means two concurrent reservations resolve to
// exactly one winner, no matter how the requests interleave.
// ---------------------------------------------------------------------------

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
  async validateSlot(itemId: string, slotStart: Date): Promise<BookingConfig> {
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
    const minutesIntoDay = slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();
    if (slotBlocked(minutesIntoDay, config.durationMinutes, itemId, exceptions)) {
      // Same face as a taken slot — a block's existence (or reason) never leaks.
      throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
    }
    return config;
  }

  /** The vendor's exception windows overlapping the slot's UTC-face date. */
  async exceptionsFor(vendorId: string, onDate: Date): Promise<ExceptionWindow[]> {
    const day = new Date(Date.UTC(onDate.getUTCFullYear(), onDate.getUTCMonth(), onDate.getUTCDate()));
    return this.prisma.bookingException.findMany({
      where: { vendorId, date: day },
      select: { itemId: true, start: true, end: true },
    });
  }

  /**
   * Reserve a slot. Throws 409 SLOT_TAKEN when someone else got there first.
   * With an orderId (vendor acceptance), the booking is CONFIRMED directly.
   */
  async reserveSlot(itemId: string, customerId: string, slotStart: Date, orderId?: string) {
    const config = await this.validateSlot(itemId, slotStart);
    const slotEnd = new Date(slotStart.getTime() + config.durationMinutes * 60_000);

    try {
      const booking = await this.prisma.booking.create({
        data: {
          itemId,
          customerId,
          slotStart,
          slotEnd,
          orderId,
          status: orderId ? 'CONFIRMED' : 'RESERVED',
        },
      });
      await this.nudgeForItem(itemId);
      return booking;
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
      }
      throw error;
    }
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
        return created;
      });
      await this.nudgeForItem(booking.itemId);
      return { booking: next, moved: true as const, previousSlotStart: booking.slotStart, serviceName: booking.item.name };
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken — pick another time');
      }
      throw error;
    }
  }

  private async nudgeForItem(itemId: string): Promise<void> {
    if (!this.io) return;
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { vendorId: true } });
    if (item) this.nudge(item.vendorId, itemId);
  }
}
