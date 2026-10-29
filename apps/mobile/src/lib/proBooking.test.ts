import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bookingDays,
  bookingRefusalRefresh,
  daysBetween,
  durationLabel,
  moveStripLength,
  hoursSummary,
  normalizeClock,
  readAppointmentView,
  serviceJobControls,
  withDayWindows,
} from './proBooking';
import { SERVICE_JOB_BOOKED_CANCEL_WORDS, SERVICE_JOB_STARTED_CANCEL_WORDS } from './serviceJobPresentation';

// [BOOK-P3] The phone renders the server's verdicts for a job booked from a pro's list, and keeps the
// quote-job rule for every other job.

const view = (over: Record<string, unknown> = {}) => ({
  canCancel: true, freeCancellationExpiresAt: '2026-11-10T13:00:00.000Z', cancellationMessage: null, cancelUnavailable: null,
  canReschedule: true, rescheduleUnavailable: null, ...over,
});
const listJob = (over: Record<string, unknown> = {}) => ({ status: 'SCHEDULED', offeringId: 'off1', scheduledFor: '2026-11-10T15:00:00.000Z', appointment: view(), ...over });

describe('what a job card offers', () => {
  it('the customer of a list-booked job: the server\'s cancel and move verdicts, nothing authored', () => {
    expect(serviceJobControls(listJob(), true)).toEqual({
      canCancel: true, contactWords: null, freeCancelUntil: '2026-11-10T13:00:00.000Z', cancelNote: null, canMove: true, moveWords: null,
    });
    const closed = listJob({ appointment: view({
      canCancel: false, freeCancellationExpiresAt: null, cancelUnavailable: { code: 'CANCEL_WINDOW_CLOSED', message: 'Contact the provider.' },
      canReschedule: false, rescheduleUnavailable: { code: 'RESCHEDULE_WINDOW_CLOSED', message: 'Contact the provider to change it.' },
    }) });
    expect(serviceJobControls(closed, true)).toEqual({
      canCancel: false, contactWords: 'Contact the provider.', freeCancelUntil: null, cancelNote: null, canMove: false, moveWords: 'Contact the provider to change it.',
    });
    const late = listJob({ appointment: view({ freeCancellationExpiresAt: null, cancellationMessage: 'Running very late: cancel free.', canReschedule: false }) });
    expect(serviceJobControls(late, true)).toMatchObject({ canCancel: true, cancelNote: 'Running very late: cancel free.', canMove: false, moveWords: null });
  });

  it('no server view (the switch off, an older server, a malformed answer): the quote-job rule, never a guess', () => {
    for (const appointment of [undefined, null, {}, { canCancel: 'yes' }]) {
      expect(serviceJobControls(listJob({ appointment }), true), JSON.stringify(appointment)).toEqual({
        canCancel: false, contactWords: SERVICE_JOB_BOOKED_CANCEL_WORDS, freeCancelUntil: null, cancelNote: null, canMove: false, moveWords: null,
      });
    }
    expect(serviceJobControls(listJob({ status: 'IN_PROGRESS', appointment: undefined }), true).contactWords).toBe(SERVICE_JOB_STARTED_CANCEL_WORDS);
  });

  it('a quote job keeps its rule even if a view were sent; nobody moves it', () => {
    const quote = { status: 'SCHEDULED', offeringId: null, scheduledFor: '2026-11-10T15:00:00.000Z', appointment: view() };
    expect(serviceJobControls(quote, true)).toMatchObject({ canCancel: false, contactWords: SERVICE_JOB_BOOKED_CANCEL_WORDS, canMove: false });
    expect(serviceJobControls(quote, false)).toMatchObject({ canCancel: true, canMove: false });
    expect(serviceJobControls({ status: 'QUOTED' }, true)).toMatchObject({ canCancel: true, canMove: false });
  });

  it('the pro: cancels a live job as before, and moves a booked list job (not a started one)', () => {
    expect(serviceJobControls(listJob({ appointment: undefined }), false)).toMatchObject({ canCancel: true, canMove: true, contactWords: null });
    expect(serviceJobControls(listJob({ status: 'IN_PROGRESS' }), false)).toMatchObject({ canCancel: true, canMove: false });
  });

  it('a closed job offers nothing to anybody', () => {
    for (const status of ['COMPLETED', 'CANCELLED']) {
      for (const isCustomer of [true, false]) {
        expect(serviceJobControls(listJob({ status }), isCustomer)).toEqual({
          canCancel: false, contactWords: null, freeCancelUntil: null, cancelNote: null, canMove: false, moveWords: null,
        });
      }
    }
  });

  it('reads the view strictly', () => {
    expect(readAppointmentView(view({ cancelUnavailable: { code: 'X', message: 7 } }))?.cancelUnavailable).toBeNull();
    expect(readAppointmentView('nope')).toBeNull();
  });
});

describe('the day strip, times and words', () => {
  it('today, tomorrow, then dated days; closed weekdays marked; never past the server\'s horizon', () => {
    // 2026-11-02 is a Monday.
    const days = bookingDays('2026-11-02', 4, [1, 3]);
    expect(days.map((d) => [d.key, d.label.split(' ')[0], d.closed])).toEqual([
      ['2026-11-02', 'Today', false], ['2026-11-03', 'Tomorrow', true], ['2026-11-04', days[2]!.label.split(' ')[0], false], ['2026-11-05', days[3]!.label.split(' ')[0], true],
    ]);
    expect(bookingDays('2026-11-02', 14, undefined, 2)).toHaveLength(3);
    expect(bookingDays('2026-11-02', 14, undefined).every((d) => !d.closed)).toBe(true);
  });

  it('a refusal reloads what changed: the times, or the services and their prices', () => {
    const err = (code: string) => ({ response: { data: { error: { code, message: 'x' } } } });
    expect(['SLOT_TAKEN', 'SLOT_UNAVAILABLE', 'TOO_SOON', 'SLOT_IN_PAST', 'TOO_FAR_AHEAD'].map((c) => bookingRefusalRefresh(err(c)))).toEqual(Array(5).fill('slots'));
    expect(['PRICE_CHANGED', 'OFFERING_UNAVAILABLE'].map((c) => bookingRefusalRefresh(err(c)))).toEqual(['offerings', 'offerings']);
    expect(bookingRefusalRefresh(err('BOOKING_LIMIT_REACHED'))).toBeNull();
    expect(bookingRefusalRefresh(new Error('offline'))).toBeNull();
  });

  it('a move\'s strip always reaches a week past the booked day', () => {
    expect(daysBetween('2026-10-29', '2026-12-01')).toBe(33);
    expect(moveStripLength('2026-10-29', '2026-12-01')).toBe(41);
    expect(moveStripLength('2026-10-29', '2026-10-30')).toBe(14);
    expect(bookingDays('2026-10-29', moveStripLength('2026-10-29', '2026-12-01'), undefined).map((d) => d.key)).toContain('2026-12-08');
  });

  it('lengths, clocks and the hours summary', () => {
    expect([30, 60, 90, 120].map(durationLabel)).toEqual(['30 min', '1 hr', '1 hr 30 min', '2 hr']);
    expect(['9:00', '09:30', '24:00', '9', ' 17:05 '].map(normalizeClock)).toEqual(['09:00', '09:30', null, null, '17:05']);
    const week = withDayWindows([{ dayOfWeek: 1, start: '09:00', end: '12:00' }], 1, [{ start: '14:00', end: '17:00' }, { start: '08:00', end: '12:00' }]);
    expect(week).toEqual([{ dayOfWeek: 1, start: '08:00', end: '12:00' }, { dayOfWeek: 1, start: '14:00', end: '17:00' }]);
    expect(hoursSummary(week)).toEqual(['Mon 08:00–12:00, 14:00–17:00']);
  });
});

describe('the screens ask the server, and the stack can open them', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the job card reads serviceJobControls and moves through the per-job times', () => {
    const card = read('src/modules/services/screens/ServiceJobsScreen.tsx');
    expect(card).toMatch(/serviceJobControls\(job, isCustomer\)/);
    expect(card).toMatch(/controls\.canMove && job\.scheduledFor \? <ProJobMoveCard/);
    const move = read('src/modules/services/ProJobMoveCard.tsx');
    expect(move).toMatch(/useJobSlots</);
    expect(move).not.toMatch(/useProSlots/);
  });

  it('a booking sends the price the customer was shown; Book appears only where the server says so', () => {
    const booking = read('src/modules/services/screens/ProBookingScreen.tsx');
    expect(booking).toMatch(/expectedPrice: offering\.price/);
    const browse = read('src/modules/services/screens/ServicesScreen.tsx');
    expect(browse).toMatch(/p\.bookableFromList === true \? \(/);
    const stack = read('src/navigation/CustomerStack.tsx');
    expect(stack).toMatch(/name="ProBooking" component=\{ProBookingScreen\}/);
    expect(stack).toMatch(/name="ProBookable" component=\{ProBookableScreen\}/);
  });
});
