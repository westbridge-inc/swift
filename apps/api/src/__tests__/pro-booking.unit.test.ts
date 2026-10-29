import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeCalendarDaySlots } from '../modules/booking/availability';
import {
  APPOINTMENT_FREE_CANCEL_BEFORE_MIN,
  APPOINTMENT_WINDOW_CLOSED_MESSAGE,
  serviceAppointmentCancelView,
  serviceJobCancelVerdict,
  SERVICE_JOB_BOOKED_MESSAGE,
} from '../modules/order/cancel-policy';
import { pickerJobInterval, PRO_MIN_NOTICE_MINUTES, providerCalendar } from '../modules/services/provider-calendar';
import { QUOTE_JOB_PICKER_BLOCK_MINUTES, serviceJobInterval } from '../modules/services/provider-time';
import { categoryTakesAppointments, publicServiceCatalog, SERVICE_TRADE_CATALOG, type ServiceTradeId } from '../modules/services/service-catalog';
import { instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [BOOK-P2 Track P] The pure rules of booking a pro: which categories take
// appointments (switch ∧ owner C4 allow-list ∧ not held), the appointment
// cancel rule (owner B1: free until two hours before, a one-minute floor, the
// very-late exit), the two hours' notice (owner C2) and a quote job's picker
// block (the P1 S4-4 ruling), and where the booking takes its locks.
// ---------------------------------------------------------------------------

const MIN = 60_000;
afterEach(() => { delete process.env['INSTANT_BOOKING']; });

describe('the catalogue: appointments only with the switch, for tutor, cleaner and photographer, never a held trade', () => {
  const trades = Object.keys(SERVICE_TRADE_CATALOG) as ServiceTradeId[];

  it('switch off: no category takes appointments', () => {
    expect(trades.filter(categoryTakesAppointments)).toEqual([]);
    expect(publicServiceCatalog().categories.every((c) => !c.appointmentsEnabled && c.modes.join() === 'QUOTE_JOB')).toBe(true);
  });

  it('switch on: exactly the three; the held barber group, the lawyer and every other trade stay quote-only', () => {
    process.env['INSTANT_BOOKING'] = '1';
    expect(trades.filter(categoryTakesAppointments).sort()).toEqual(['cleaner', 'photographer', 'tutor']);
    for (const held of ['barber', 'hairdresser', 'salon', 'nail_technician', 'makeup_artist', 'lawyer'] as ServiceTradeId[]) {
      expect(categoryTakesAppointments(held), held).toBe(false);
    }
    const tutor = publicServiceCatalog().categories.find((c) => c.id === 'tutor')!;
    expect([tutor.modes, tutor.appointmentsEnabled, tutor.quoteRequestsEnabled]).toEqual([['QUOTE_JOB', 'APPOINTMENT'], true, true]);
    // The words builds 9-12 show stay true for them: they cannot book from a menu.
    expect(tutor.availabilityMessage).toBe('Request a quote and agree a time with your provider. Instant appointment booking is not available yet.');
  });

  it('the switch is on only when exactly "1"', () => {
    for (const value of ['true', 'yes', '0', '']) {
      process.env['INSTANT_BOOKING'] = value;
      expect(categoryTakesAppointments('tutor'), value).toBe(false);
    }
  });
});

describe('owner B1: a pro appointment cancels free until two hours before it starts', () => {
  const start = new Date('2026-11-10T14:00:00.000Z');
  const booked = { status: 'SCHEDULED', offeringId: 'off-1', scheduledFor: start, providerConfirmedAt: new Date('2026-11-01T12:00:00.000Z') };
  const at = (minutesBeforeStart: number) => new Date(start.getTime() - minutesBeforeStart * MIN);

  it('switch on: free until exactly two hours before, then refused in the store appointment\'s words', () => {
    process.env['INSTANT_BOOKING'] = '1';
    expect(APPOINTMENT_FREE_CANCEL_BEFORE_MIN).toBe(120);
    expect(serviceJobCancelVerdict(booked, at(121))).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(serviceJobCancelVerdict(booked, at(120))).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(serviceJobCancelVerdict(booked, at(119))).toEqual({ allowed: false, free: false, code: 'CANCEL_WINDOW_CLOSED', message: APPOINTMENT_WINDOW_CLOSED_MESSAGE });
    expect(serviceAppointmentCancelView(booked, at(200))).toEqual({
      canCancel: true, freeCancellationExpiresAt: at(120).toISOString(), cancellationMessage: null, cancelUnavailable: null,
    });
  });

  it('a booking confirmed inside two hours still cancels free for one minute after it was confirmed', () => {
    process.env['INSTANT_BOOKING'] = '1';
    const late = { ...booked, providerConfirmedAt: at(30) };
    expect(serviceJobCancelVerdict(late, at(29.5))).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(serviceJobCancelVerdict(late, at(28.9))).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
  });

  it('a pro thirty minutes late and not started frees it again; a started job never cancels in the app', () => {
    process.env['INSTANT_BOOKING'] = '1';
    expect(serviceJobCancelVerdict(booked, at(-29))).toMatchObject({ allowed: false });
    expect(serviceJobCancelVerdict(booked, at(-30))).toMatchObject({ allowed: true, reason: 'TOO_LATE' });
    expect(serviceJobCancelVerdict({ ...booked, status: 'IN_PROGRESS' }, at(-60))).toMatchObject({ allowed: false, code: 'SERVICE_JOB_STARTED' });
  });

  it('switch off, or a quote job: the rule the Terms already state (refused once booked)', () => {
    expect(serviceJobCancelVerdict(booked, at(600))).toEqual({ allowed: false, free: false, code: 'SERVICE_JOB_BOOKED', message: SERVICE_JOB_BOOKED_MESSAGE });
    process.env['INSTANT_BOOKING'] = '1';
    expect(serviceJobCancelVerdict({ ...booked, offeringId: null }, at(600))).toMatchObject({ allowed: false, code: 'SERVICE_JOB_BOOKED' });
    expect(serviceJobCancelVerdict({ status: 'QUOTED' })).toMatchObject({ allowed: true, reason: 'NOT_ACCEPTED' });
  });
});

describe('owner C2 and the P1 S4-4 ruling: what a booking from the menu keeps clear of', () => {
  const Y = 2026; const M = 11; const D = 3; // a Tuesday
  const at = (hh: number, mm = 0) => instantOfGuyanaWallClock(new Date(Date.UTC(Y, M - 1, D, hh, mm)));
  const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Guyana', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const day = (now: Date, busy = [] as ReturnType<typeof pickerJobInterval>[]) => computeCalendarDaySlots({
    calendar: providerCalendar([{ dayOfWeek: 2, start: '09:00', end: '17:00' }], { durationMinutes: 60 }),
    blocks: [], busy, capacity: 1, year: Y, month: M, day: D, now,
  }).map(hhmm);

  it('two hours\' notice: at 09:30 the first bookable start is 12:00 (11:30 is not on the stride)', () => {
    expect(PRO_MIN_NOTICE_MINUTES).toBe(120);
    expect(day(at(9, 30))).toEqual(['12:00', '13:00', '14:00', '15:00', '16:00']);
  });

  it('a quote job holds two hours of the day for a booking; the database twin still holds its minute', () => {
    expect(QUOTE_JOB_PICKER_BLOCK_MINUTES).toBe(120);
    const quote = { scheduledFor: at(10), endsAt: null };
    expect(serviceJobInterval(quote).end.getTime() - at(10).getTime()).toBe(MIN);
    expect(pickerJobInterval(quote)).toEqual({ start: at(10), end: at(12) });
    // A booked service holds exactly what the database holds.
    expect(pickerJobInterval({ scheduledFor: at(10), endsAt: at(11, 30) })).toEqual(serviceJobInterval({ scheduledFor: at(10), endsAt: at(11, 30) }));
    expect(day(new Date(Date.UTC(2026, 9, 29)), [pickerJobInterval(quote)])).toEqual(['09:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  });
});

describe('where the booking takes its locks (no deadlock with a move, the quote flow or the store checkout)', () => {
  const routes = readFileSync(join(process.cwd(), 'src/modules/services/pro-booking.routes.ts'), 'utf8');

  it('a booking: the customer\'s booking lock, then the pro\'s time, then both User rows; the weekly-fee hook is called', () => {
    const book = routes.slice(routes.indexOf("app.post('/jobs/book'"), routes.indexOf('/** POST /jobs/:id/reschedule'));
    const order = ['await lockCustomerBookings(tx, customerId);', 'await lockProviderTime(tx, body.providerId);', 'FOR UPDATE /* pro-booking-live-authority */', 'await assertProviderCanOperate(tx, provider);', 'await assertBookableTime(tx, {', 'tx.serviceJob.create('];
    const positions = order.map((s) => book.indexOf(s));
    expect(positions.every((p) => p >= 0), String(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('a move: the pro\'s time before the time check and the job write', () => {
    const move = routes.slice(routes.indexOf("app.post<{ Params: { id: string } }>('/jobs/:id/reschedule'"));
    const order = ['await lockProviderTime(tx, job.providerId);', 'await assertBookableTime(tx, {', 'transitionServiceJob(tx, {'];
    const positions = order.map((s) => move.indexOf(s));
    expect(positions.every((p) => p >= 0), String(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
