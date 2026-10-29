import { describe, expect, it } from 'vitest';
import {
  computeCalendarDaySlots,
  computeDaySlots,
  type BusyInterval,
  type ExceptionWindow,
} from '../modules/booking/availability';
import type { BookingConfig } from '../modules/booking/booking.service';
import {
  BOOKABLE_PRO_TRADES,
  isProTradeBookable,
  offeringCreateSchema,
  providerCalendar,
  storedWeeklyHours,
  timeOffSchema,
  weeklyHoursForSave,
} from '../modules/services/provider-calendar';
import {
  isServiceJobExclusionViolation,
  QUOTE_JOB_MIN_BLOCK_MINUTES,
  SERVICE_JOB_EXCLUSION,
  SERVICE_JOB_RANGE_SQL,
  serviceJobInterval,
} from '../modules/services/provider-time';
import { canonicalServiceTrade, isServiceCategoryOperational, SERVICE_TRADE_CATALOG, type ServiceTradeId } from '../modules/services/service-catalog';
import { instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [BOOK-P1 Track P] A pro's calendar is computed by the SAME engine as a store
// listing's: weekly hours with one service's length, minus the day's time off,
// minus the time every live job of theirs holds (a booked service its whole
// length, a quote job its minimum block). The generalised engine gives a
// listing exactly what it gave before.
// ---------------------------------------------------------------------------

/** 2026-11-03 is a Tuesday (dayOfWeek 2). */
const Y = 2026; const M = 11; const D = 3;
const at = (hh: number, mm = 0, ss = 0) => instantOfGuyanaWallClock(new Date(Date.UTC(Y, M - 1, D, hh, mm, ss)));
const NOW = new Date(Date.UTC(2026, 9, 29, 12));
const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guyana', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const TUESDAY_9_TO_5 = [{ dayOfWeek: 2, start: '09:00', end: '17:00' }];

function proSlots(opts: { hours?: unknown; minutes: number; busy?: BusyInterval[]; blocks?: Array<{ start: string | null; end: string | null }> }) {
  return computeCalendarDaySlots({
    calendar: providerCalendar('hours' in opts ? opts.hours : TUESDAY_9_TO_5, { durationMinutes: opts.minutes }),
    blocks: opts.blocks ?? [],
    busy: opts.busy ?? [],
    capacity: 1,
    year: Y, month: M, day: D, now: NOW,
  }).map(hhmm);
}

describe('a pro calendar: weekly hours with one service length', () => {
  it('offers the hours on the service stride, and nothing on a day without hours', () => {
    expect(proSlots({ minutes: 120 })).toEqual(['09:00', '11:00', '13:00', '15:00']);
    expect(proSlots({ hours: [{ dayOfWeek: 3, start: '09:00', end: '17:00' }], minutes: 60 })).toEqual([]);
    expect(proSlots({ hours: null, minutes: 60 })).toEqual([]);
  });

  it('a 09:00 three-hour booked job holds 09:00 to 12:00: 10:00 and 11:00 are gone, 12:00 is free (back to back)', () => {
    const job = serviceJobInterval({ scheduledFor: at(9), endsAt: at(12) });
    expect(proSlots({ minutes: 60, busy: [job] })).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00']);
  });

  it('a quote job (no end) holds only its minimum block: the slot it starts in, not the hour after', () => {
    expect(QUOTE_JOB_MIN_BLOCK_MINUTES).toBe(1);
    const quote = serviceJobInterval({ scheduledFor: at(10, 30), endsAt: null });
    expect(quote.end.getTime() - quote.start.getTime()).toBe(60_000);
    // A 60-minute slot from 10:00 covers 10:30, so it is gone; 11:00 is free.
    expect(proSlots({ minutes: 60, busy: [quote] })).toEqual(['09:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  });

  it('time off: a whole day blocks everything, a window blocks what overlaps it', () => {
    expect(proSlots({ minutes: 60, blocks: [{ start: null, end: null }] })).toEqual([]);
    expect(proSlots({ minutes: 60, blocks: [{ start: '12:30', end: '14:00' }] })).toEqual(['09:00', '10:00', '11:00', '14:00', '15:00', '16:00']);
  });

  it('only well-formed stored hours count', () => {
    expect(storedWeeklyHours([{ dayOfWeek: 2, start: '09:00', end: '12:00' }, { dayOfWeek: 2, start: '9', end: 'x' }, null, 'junk'])).toEqual([
      { dayOfWeek: 2, start: '09:00', end: '12:00' },
    ]);
    expect(storedWeeklyHours({ slots: [] })).toEqual([]);
  });
});

describe('one engine: a store listing gets exactly what it got before', () => {
  const config: BookingConfig = {
    durationMinutes: 45,
    bufferMinutes: 15,
    minNoticeMinutes: 0,
    slots: [{ dayOfWeek: 2, start: '08:00', end: '12:00' }, { dayOfWeek: 2, start: '13:00', end: '18:00' }],
  };
  const exceptions: ExceptionWindow[] = [
    { itemId: 'item-a', start: '09:00', end: '10:00' }, // this listing's own block
    { itemId: 'item-b', start: '14:00', end: '16:00' }, // another listing's: not this one's
    { itemId: null, start: '17:00', end: '18:00' }, // the whole business
  ];
  const busy = [{ start: at(13), end: at(13, 45) }];

  it('computeDaySlots (a listing) equals computeCalendarDaySlots with that listing blocks', () => {
    const listing = computeDaySlots({ itemId: 'item-a', config, year: Y, month: M, day: D, exceptions, busy, capacity: 1, now: NOW }).map(hhmm);
    const calendar = computeCalendarDaySlots({
      calendar: config, blocks: [exceptions[0]!, exceptions[2]!], year: Y, month: M, day: D, busy, capacity: 1, now: NOW,
    }).map(hhmm);
    expect(listing).toEqual(['08:00', '10:00', '11:00', '14:00', '15:00', '16:00']);
    expect(calendar).toEqual(listing);
  });
});

describe('one pro, one time: the application twin of the database range', () => {
  it('the SQL range is [scheduledFor, endsAt), or the minimum block', () => {
    expect(SERVICE_JOB_RANGE_SQL).toBe(`tsrange("scheduledFor", COALESCE("endsAt", "scheduledFor" + interval '${QUOTE_JOB_MIN_BLOCK_MINUTES} minute'))`);
    const booked = serviceJobInterval({ scheduledFor: at(9), endsAt: at(10) });
    expect([booked.start, booked.end]).toEqual([at(9), at(10)]);
  });

  it('a lost exclusion reads as a slot conflict, by code or by the constraint name', () => {
    expect(isServiceJobExclusionViolation({ code: '23P01' })).toBe(true);
    expect(isServiceJobExclusionViolation({ meta: { code: '23P01' } })).toBe(true);
    expect(isServiceJobExclusionViolation({ message: `conflicting key value violates exclusion constraint "${SERVICE_JOB_EXCLUSION}"` })).toBe(true);
    expect(isServiceJobExclusionViolation({ code: 'P2002' })).toBe(false);
    expect(isServiceJobExclusionViolation(null)).toBe(false);
  });
});

describe('what a pro may set up', () => {
  it('owner C4: tutor, cleaner and photographer have a bookable menu; a held trade never does', () => {
    expect([...BOOKABLE_PRO_TRADES].sort()).toEqual(['cleaner', 'photographer', 'tutor']);
    for (const trade of Object.keys(SERVICE_TRADE_CATALOG) as ServiceTradeId[]) {
      expect(isProTradeBookable(trade), trade).toBe(BOOKABLE_PRO_TRADES.has(trade) && isServiceCategoryOperational(trade));
    }
    for (const held of ['barber', 'hairdresser', 'salon', 'nail_technician', 'makeup_artist', 'lawyer'] as ServiceTradeId[]) {
      expect(isProTradeBookable(held), held).toBe(false);
    }
    expect(isProTradeBookable(canonicalServiceTrade('Tutoring'))).toBe(true);
    expect(isProTradeBookable(canonicalServiceTrade('electrician'))).toBe(false);
    expect(isProTradeBookable(null)).toBe(false);
  });

  it('weekly hours: no empty window, no two overlapping on one day; back to back is fine; stored in day order', () => {
    expect(() => weeklyHoursForSave([{ dayOfWeek: 1, start: '12:00', end: '12:00' }])).toThrow(/end after it starts/);
    expect(() => weeklyHoursForSave([{ dayOfWeek: 1, start: '09:00', end: '12:00' }, { dayOfWeek: 1, start: '11:00', end: '14:00' }])).toThrow(/overlap/);
    expect(weeklyHoursForSave([
      { dayOfWeek: 3, start: '13:00', end: '17:00' },
      { dayOfWeek: 1, start: '12:00', end: '17:00' },
      { dayOfWeek: 1, start: '09:00', end: '12:00' },
    ])).toEqual([
      { dayOfWeek: 1, start: '09:00', end: '12:00' },
      { dayOfWeek: 1, start: '12:00', end: '17:00' },
      { dayOfWeek: 3, start: '13:00', end: '17:00' },
    ]);
  });

  it('a service: a name, 5 to 600 minutes, a price a quote could carry', () => {
    expect(offeringCreateSchema.safeParse({ name: 'Maths lesson', durationMinutes: 60, price: 3000 }).success).toBe(true);
    expect(offeringCreateSchema.safeParse({ name: 'Maths lesson', durationMinutes: 4, price: 3000 }).success).toBe(false);
    expect(offeringCreateSchema.safeParse({ name: 'Maths lesson', durationMinutes: 601, price: 3000 }).success).toBe(false);
    expect(offeringCreateSchema.safeParse({ name: 'Maths lesson', durationMinutes: 60, price: 0 }).success).toBe(false);
    expect(offeringCreateSchema.safeParse({ name: 'Maths lesson', durationMinutes: 60, price: 10.005 }).success).toBe(false);
    expect(offeringCreateSchema.safeParse({ name: 'M', durationMinutes: 60, price: 3000 }).success).toBe(false);
  });

  it('time off: a whole day, or a window whose start and end come together, start first', () => {
    expect(timeOffSchema.safeParse({ date: '2026-11-03' }).success).toBe(true);
    expect(timeOffSchema.safeParse({ date: '2026-11-03', start: '13:00', end: '15:00' }).success).toBe(true);
    expect(timeOffSchema.safeParse({ date: '2026-11-03', start: '13:00' }).success).toBe(false);
    expect(timeOffSchema.safeParse({ date: '2026-11-03', start: '15:00', end: '13:00' }).success).toBe(false);
    expect(timeOffSchema.safeParse({ date: '3 Nov' }).success).toBe(false);
  });
});
