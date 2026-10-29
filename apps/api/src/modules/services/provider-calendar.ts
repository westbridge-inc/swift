import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from '../../lib/zod';
import { AppError } from '../../utils/errors';
import {
  computeCalendarDaySlots,
  type BookingCalendar,
  type BusyInterval,
  type CalendarBlock,
} from '../booking/availability';
import { overlappingWindows, overlappingWindowsMessage, type BookingWindow } from '../booking/booking-config';
import { endOfGuyanaDay, guyanaWallClockParts, startOfGuyanaDay } from '../../utils/guyana-day';
import { serviceQuoteAmountSchema } from './service-job-transition';
import { BOOKABLE_PRO_TRADES, isProTradeBookable } from './service-catalog';
import {
  LIVE_SERVICE_JOB_STATUSES,
  MAX_OFFERING_MINUTES,
  MIN_OFFERING_MINUTES,
  QUOTE_JOB_PICKER_BLOCK_MINUTES,
  serviceJobInterval,
} from './provider-time';

// ---------------------------------------------------------------------------
// [BOOK-P1 Track P] A PRO'S CALENDAR — the provider's half of the one engine.
//
// A pro's calendar is their weekly hours (ServiceProvider.weeklyHours, the
// shape of a listing's bookingConfig.slots) with the length of one of their
// services (ServiceOffering.durationMinutes). Their time off on a date is the
// day's blocks, and the time already held is every live job of theirs
// (provider-time.ts serviceJobInterval: a booked service holds its length, a
// quote job its minimum block). The slots are computed by the SAME function as
// a store listing's (booking/availability.ts computeCalendarDaySlots); a pro
// serves one customer at a time.
//
// P1 builds the calendar and the provider's own settings (offerings, hours,
// time off), behind INSTANT_BOOKING. [BOOK-P2] The customer's slot list and
// booking (services/pro-booking.routes.ts) read the SAME day computation, so
// a time the list offers is a time the booking accepts, and nothing else:
//  - [owner C2, 28 Oct 2026] a pro is booked at least two hours ahead
//    (PRO_MIN_NOTICE_MINUTES), the default a business has too;
//  - a quote job (no end) holds QUOTE_JOB_PICKER_BLOCK_MINUTES of the pro's
//    day for a booking from the menu (pickerJobInterval). The database still
//    holds only its minute (provider-time.ts), so the quote flow of builds 9,
//    11 and 12 is unchanged; a booking the pro never confirms must not land
//    in the middle of a visit whose length nobody wrote down.
// ---------------------------------------------------------------------------

/** [owner C4, 28 Oct 2026] The first pro categories with a bookable menu. A trade the
 *  catalogue holds (the barber group, 15 Oct) is never bookable, whatever this list says.
 *  [BOOK-P2] Declared with the catalogue (service-catalog.ts), which says per category
 *  whether appointments are on; re-exported here, where P1 named them. */
export { BOOKABLE_PRO_TRADES, isProTradeBookable };

/** [BOOK-P2 · owner C2, 28 Oct 2026] The least notice a booking from a pro's menu takes: two hours. */
export const PRO_MIN_NOTICE_MINUTES = 120;

/** The most services one provider keeps, and the most days off ahead. */
export const MAX_OFFERINGS_PER_PROVIDER = 30;
export const MAX_UPCOMING_TIME_OFF = 100;
/** How far ahead a day off may be set. */
export const TIME_OFF_HORIZON_DAYS = 366;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const offeringCreateSchema = z.object({
  name: z.string().trim().min(2).max(80),
  durationMinutes: z.number().int().min(MIN_OFFERING_MINUTES).max(MAX_OFFERING_MINUTES),
  price: serviceQuoteAmountSchema,
});

export const offeringUpdateSchema = offeringCreateSchema.partial().extend({ active: z.boolean().optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to change' });

export const weeklyHoursSchema = z.object({
  slots: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    start: z.string().regex(HHMM),
    end: z.string().regex(HHMM),
  })).max(50),
});

export const timeOffSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(HHMM).optional(),
  end: z.string().regex(HHMM).optional(),
})
  .refine((b) => (b.start == null) === (b.end == null), { message: 'start and end come together' })
  .refine((b) => b.start == null || b.end == null || b.start < b.end, { message: 'start must be before end' });

/** The weekly hours to store, or the refusal: every window ends after it starts, and no two on one day overlap. */
export function weeklyHoursForSave(slots: readonly BookingWindow[]): BookingWindow[] {
  const empty = slots.find((w) => w.end <= w.start);
  if (empty) throw new AppError(400, 'EMPTY_HOURS', `An opening time must end after it starts (${empty.start}–${empty.end}).`);
  const pair = overlappingWindows(slots);
  if (pair) throw new AppError(400, 'OVERLAPPING_HOURS', overlappingWindowsMessage(pair));
  return [...slots]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.start.localeCompare(b.start))
    .map((w) => ({ dayOfWeek: w.dayOfWeek, start: w.start, end: w.end }));
}

/** A stored weeklyHours value read back: only well-formed windows count. */
export function storedWeeklyHours(stored: unknown): BookingWindow[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter((w): w is BookingWindow => !!w && typeof w === 'object'
    && Number.isInteger((w as BookingWindow).dayOfWeek)
    && typeof (w as BookingWindow).start === 'string' && HHMM.test((w as BookingWindow).start)
    && typeof (w as BookingWindow).end === 'string' && HHMM.test((w as BookingWindow).end));
}

/** The calendar of one provider booking one of their services: their hours, its length,
 *  and [BOOK-P2 · owner C2] two hours' notice. */
export function providerCalendar(weeklyHours: unknown, offering: { durationMinutes: number }): BookingCalendar {
  return { slots: storedWeeklyHours(weeklyHours), durationMinutes: offering.durationMinutes, minNoticeMinutes: PRO_MIN_NOTICE_MINUTES };
}

/** [BOOK-P2 · P1 S4-4] The time a live job holds of the pro's day FOR A BOOKING from the menu:
 *  a booked service its whole length (exactly what the database holds), a quote job
 *  QUOTE_JOB_PICKER_BLOCK_MINUTES (the database holds its minute: provider-time.ts). */
export function pickerJobInterval(job: { scheduledFor: Date; endsAt: Date | null }): BusyInterval {
  if (job.endsAt) return serviceJobInterval(job);
  return { start: job.scheduledFor, end: new Date(job.scheduledFor.getTime() + QUOTE_JOB_PICKER_BLOCK_MINUTES * 60_000) };
}

type CalendarDb = Prisma.TransactionClient | PrismaClient;

/** The provider's time held by their live jobs that can reach [from, to), as a booking from
 *  the menu sees it (pickerJobInterval). A job holds at most MAX_OFFERING_MINUTES (a quote
 *  job's picker block is shorter), so the read reaches back that far. [BOOK-P2] A job being
 *  moved (`excludeJobId`) does not hold the time it is leaving. */
export async function providerTime(db: CalendarDb, providerId: string, from: Date, to: Date, excludeJobId?: string): Promise<BusyInterval[]> {
  const rows = await db.serviceJob.findMany({
    where: {
      providerId,
      status: { in: [...LIVE_SERVICE_JOB_STATUSES] },
      scheduledFor: { not: null, lt: to, gt: new Date(from.getTime() - MAX_OFFERING_MINUTES * 60_000) },
      ...(excludeJobId ? { id: { not: excludeJobId } } : {}),
    },
    select: { scheduledFor: true, endsAt: true },
  });
  return rows
    .map((r) => pickerJobInterval({ scheduledFor: r.scheduledFor!, endsAt: r.endsAt }))
    .filter((b) => b.start < to && b.end > from);
}

/** The provider's time off on one Guyana calendar date ("YYYY-MM-DD"). */
export async function providerBlocksOn(db: CalendarDb, providerId: string, date: string): Promise<CalendarBlock[]> {
  const [y, m, d] = date.split('-').map(Number);
  return db.serviceProviderTimeOff.findMany({
    where: { providerId, date: new Date(Date.UTC(y!, m! - 1, d!)) },
    select: { start: true, end: true },
  });
}

/** The true slot instants of one Guyana date on which this provider could start this service. */
export async function providerDaySlots(
  db: CalendarDb,
  input: {
    providerId: string; weeklyHours: unknown; offering: { durationMinutes: number }; date: string; now?: Date;
    /** [BOOK-P2] A job being moved does not hold the time it leaves. */
    excludeJobId?: string;
    /** [BOOK-P2] The pro's open calendar only (hours, stride, notice, time off), no job subtracted:
     *  tells a time another job holds (SLOT_TAKEN) from a time that was never open. */
    ignoreJobs?: boolean;
  },
): Promise<Date[]> {
  const calendar = providerCalendar(input.weeklyHours, input.offering);
  const reachEnd = new Date(endOfGuyanaDay(input.date).getTime() + calendar.durationMinutes * 60_000);
  const [blocks, busy] = await Promise.all([
    providerBlocksOn(db, input.providerId, input.date),
    input.ignoreJobs ? Promise.resolve([]) : providerTime(db, input.providerId, startOfGuyanaDay(input.date), reachEnd, input.excludeJobId),
  ]);
  const [year, month, day] = input.date.split('-').map(Number);
  return computeCalendarDaySlots({
    calendar, blocks, busy, capacity: 1, year: year!, month: month!, day: day!, now: input.now ?? new Date(),
  });
}

/** Today's Guyana calendar date as stored in a date-only column. */
export function guyanaToday(now = new Date()): Date {
  const local = guyanaWallClockParts(now);
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}
