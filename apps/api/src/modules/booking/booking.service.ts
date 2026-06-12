import type { PrismaClient, Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';

/** Shape stored in Item.bookingConfig for SERVICE listings. */
export interface BookingConfig {
  durationMinutes: number;
  slots: Array<{ dayOfWeek: number; start: string; end: string }>;
}

// ---------------------------------------------------------------------------
// BookingService — appointment slots on SERVICE listings. The double-booking
// guarantee is the database's: a partial unique index on (itemId, slotStart)
// for non-CANCELLED rows means two concurrent reservations resolve to
// exactly one winner, no matter how the requests interleave.
// ---------------------------------------------------------------------------

export class BookingService {
  constructor(private prisma: PrismaClient) {}

  /** Reserve a slot. Throws 409 SLOT_TAKEN when someone else got there first. */
  async reserveSlot(itemId: string, customerId: string, slotStart: Date) {
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, fulfillment: true, bookingConfig: true, isAvailable: true },
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
    this.assertSlotFitsConfig(slotStart, config);

    const slotEnd = new Date(slotStart.getTime() + config.durationMinutes * 60_000);

    try {
      return await this.prisma.booking.create({
        data: { itemId, customerId, slotStart, slotEnd },
      });
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
    return this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CANCELLED' },
    });
  }

  /** The slot must start inside a configured window, aligned to the duration. */
  private assertSlotFitsConfig(slotStart: Date, config: BookingConfig) {
    if (!config.durationMinutes || !Array.isArray(config.slots)) {
      throw new AppError(400, 'BAD_BOOKING_CONFIG', 'This listing has an invalid booking configuration');
    }

    const day = slotStart.getUTCDay();
    const minutesIntoDay = slotStart.getUTCHours() * 60 + slotStart.getUTCMinutes();

    const window = config.slots.find((s) => {
      if (s.dayOfWeek !== day) return false;
      const start = toMinutes(s.start);
      const end = toMinutes(s.end);
      return (
        minutesIntoDay >= start &&
        minutesIntoDay + config.durationMinutes <= end &&
        (minutesIntoDay - start) % config.durationMinutes === 0
      );
    });

    if (!window) {
      throw new AppError(400, 'SLOT_OUTSIDE_HOURS', 'That time is not offered for this service');
    }
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
