import { describe, expect, it } from 'vitest';
import {
  BUFFER_CHOICES,
  NOTICE_CHOICES,
  choicesWith,
  instantBookingAvailable,
  minutesLabel,
  newListingHours,
  nextWindow,
  openingBookingSettings,
  slotsFromWeekHours,
  weekHoursFromSlots,
  weekHoursProblem,
} from './bookingHours';

// [BOOK-S5a · owner A4/C2] The partner editor's booking settings, before the server judges the save.

describe('hours per day', () => {
  it('every stored window is kept per day, in time order (never one window put on every day)', () => {
    const week = weekHoursFromSlots([
      { dayOfWeek: 2, start: '10:00', end: '14:00' },
      { dayOfWeek: 1, start: '13:00', end: '17:00' },
      { dayOfWeek: 1, start: '09:00', end: '12:00' },
    ]);
    expect(week[1]).toEqual([{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }]);
    expect(week[2]).toEqual([{ start: '10:00', end: '14:00' }]);
    expect(week[0]).toEqual([]);
    expect(slotsFromWeekHours(week)).toEqual([
      { dayOfWeek: 1, start: '09:00', end: '12:00' },
      { dayOfWeek: 1, start: '13:00', end: '17:00' },
      { dayOfWeek: 2, start: '10:00', end: '14:00' },
    ]);
  });

  it('nothing stored (a new service): Monday to Friday, 09:00 to 17:00', () => {
    for (const none of [undefined, null, [], 'x']) expect(weekHoursFromSlots(none)).toEqual(newListingHours());
    expect(slotsFromWeekHours(newListingHours()).map((s) => s.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a broken stored window is skipped, never invented', () => {
    expect(weekHoursFromSlots([{ dayOfWeek: 9, start: '09:00', end: '10:00' }, { dayOfWeek: 1, start: 9 }, { dayOfWeek: 3, start: '08:00', end: '09:00' }]))
      .toEqual([[], [], [], [{ start: '08:00', end: '09:00' }], [], [], []]);
  });

  it('the save trims what was typed', () => {
    expect(slotsFromWeekHours([[], [{ start: ' 09:00', end: '12:00 ' }], [], [], [], [], []])).toEqual([{ dayOfWeek: 1, start: '09:00', end: '12:00' }]);
  });
});

describe('what is wrong with the hours, in plain words', () => {
  const week = (monday: Array<{ start: string; end: string }>) => [[], monday, [], [], [], [], []];
  it('fine: one window, a break, back to back', () => {
    expect(weekHoursProblem(week([{ start: '09:00', end: '17:00' }]))).toBeNull();
    expect(weekHoursProblem(week([{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }]))).toBeNull();
    expect(weekHoursProblem(week([{ start: '09:00', end: '12:00' }, { start: '12:00', end: '17:00' }]))).toBeNull();
  });
  it('no day open', () => {
    expect(weekHoursProblem([[], [], [], [], [], [], []])).toBe('Pick at least one day with hours.');
  });
  it('not HH:MM', () => {
    expect(weekHoursProblem(week([{ start: '9', end: '17:00' }]))).toBe('On Monday, write times as HH:MM, like 09:00.');
    expect(weekHoursProblem(week([{ start: '09:00', end: '24:00' }]))).toBe('On Monday, write times as HH:MM, like 09:00.');
  });
  it('ends before it starts', () => {
    expect(weekHoursProblem(week([{ start: '17:00', end: '09:00' }]))).toBe('On Monday, 17:00–09:00 must start before it ends.');
    expect(weekHoursProblem(week([{ start: '09:00', end: '09:00' }]))).toBe('On Monday, 09:00–09:00 must start before it ends.');
  });
  it('overlap on one day, whatever order they were typed in', () => {
    expect(weekHoursProblem(week([{ start: '11:00', end: '13:00' }, { start: '09:00', end: '12:00' }])))
      .toBe('On Monday, 09:00–12:00 and 11:00–13:00 overlap. Join them into one, or change one.');
  });
});

describe('Add hours', () => {
  it('an hour after the last window ends, for two hours; a closed day opens 09:00–17:00', () => {
    expect(nextWindow([{ start: '09:00', end: '12:00' }])).toEqual({ start: '13:00', end: '15:00' });
    expect(nextWindow([{ start: '13:00', end: '17:00' }, { start: '09:00', end: '12:00' }])).toEqual({ start: '18:00', end: '20:00' });
    expect(nextWindow([])).toEqual({ start: '09:00', end: '17:00' });
  });
  it('stays inside the day', () => {
    expect(nextWindow([{ start: '18:00', end: '23:00' }])).toEqual({ start: '22:00', end: '23:59' });
  });
});

describe('the gap and the notice', () => {
  it('reads as words', () => {
    expect(BUFFER_CHOICES.map(minutesLabel)).toEqual(['None', '5 min', '10 min', '15 min', '30 min', '1 hour']);
    expect(NOTICE_CHOICES.map(minutesLabel)).toEqual(['None', '1 hour', '2 hours', '4 hours', '1 day']);
    expect(minutesLabel(2880)).toBe('2 days');
    expect(minutesLabel(90)).toBe('90 min');
  });
  it('a stored value that is not a standard choice is offered too, never silently changed', () => {
    expect(choicesWith(NOTICE_CHOICES, 90)).toEqual([0, 60, 90, 120, 240, 1440]);
    expect(choicesWith(NOTICE_CHOICES, 120)).toEqual([...NOTICE_CHOICES]);
  });
});

describe('the opening settings follow the server', () => {
  it('a new bookable service while the setting can be chosen: confirmed automatically, 2 hours\' notice (owner A4/C2)', () => {
    expect(openingBookingSettings(null, true)).toEqual({ instantBooking: true, bufferMinutes: 0, minNoticeMinutes: 120 });
  });
  it('a new bookable service while it cannot (switch off, older server): today\'s — no setting, no notice', () => {
    expect(openingBookingSettings(null, false)).toEqual({ instantBooking: false, bufferMinutes: 0, minNoticeMinutes: 0 });
  });
  it('an existing listing keeps what it stores', () => {
    const stored = { durationMinutes: 60, slots: [], instantBooking: true, bufferMinutes: 15, minNoticeMinutes: 90 };
    expect(openingBookingSettings(stored, true)).toEqual({ instantBooking: true, bufferMinutes: 15, minNoticeMinutes: 90 });
    expect(openingBookingSettings({ durationMinutes: 60, slots: [] }, true)).toEqual({ instantBooking: false, bufferMinutes: 0, minNoticeMinutes: 0 });
  });
  it('the setting is never shown as on while it cannot be chosen, whatever is stored', () => {
    expect(openingBookingSettings({ durationMinutes: 60, slots: [], instantBooking: true }, false).instantBooking).toBe(false);
  });
  it('only instantBookingAvailable === true is the server\'s word', () => {
    expect(instantBookingAvailable({ instantBookingAvailable: true })).toBe(true);
    for (const v of [undefined, null, {}, { instantBookingAvailable: 'true' }, { instantBookingAvailable: 1 }]) expect(instantBookingAvailable(v)).toBe(false);
  });
});
