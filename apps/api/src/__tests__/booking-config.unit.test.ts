import { describe, expect, it } from 'vitest';
import { joinOverlappingWindows, windowsForSave } from '../modules/booking/booking-config';
import { peakMoment } from '../modules/booking/availability';

// ---------------------------------------------------------------------------
// [BOOK-S1 · REVIEW-M S4-3 / S4-1] A listing saved before overlapping opening
// times were refused may store them; any app build that saves it unchanged is
// accepted and the overlapping windows are joined, while an overlap the save
// adds is refused. And the moment a business holds the most appointments at
// once, which decides whether "how many at once" may be lowered.
// ---------------------------------------------------------------------------

const w = (dayOfWeek: number, start: string, end: string) => ({ dayOfWeek, start, end });
const LEGACY = { durationMinutes: 60, slots: [w(1, '09:00', '12:00'), w(1, '09:30', '12:30'), w(2, '09:00', '17:00')] };

describe('windowsForSave', () => {
  it('no overlap: stored exactly as sent', () => {
    const slots = [w(1, '09:00', '12:00'), w(1, '12:00', '17:00'), w(2, '09:30', '12:30')];
    expect(windowsForSave(slots, LEGACY)).toEqual({ ok: true, slots });
  });

  it('a listing that already stores overlapping windows, saved again unchanged: joined, not refused', () => {
    expect(windowsForSave(LEGACY.slots, LEGACY)).toEqual({ ok: true, slots: [w(1, '09:00', '12:30'), w(2, '09:00', '17:00')] });
  });

  it('a build-9-shaped save of that listing (one window per chosen day) is accepted as sent', () => {
    const build9 = [w(1, '09:00', '12:00'), w(2, '09:00', '12:00')];
    expect(windowsForSave(build9, LEGACY)).toEqual({ ok: true, slots: build9 });
  });

  it('an overlap the save adds is refused, naming the new pair — even beside stored ones', () => {
    const added = [...LEGACY.slots, w(2, '16:00', '18:00')];
    expect(windowsForSave(added, LEGACY)).toEqual({ ok: false, pair: [w(2, '09:00', '17:00'), w(2, '16:00', '18:00')] });
    expect(windowsForSave([w(3, '09:00', '12:00'), w(3, '11:00', '13:00')], null)).toMatchObject({ ok: false });
  });
});

describe('windowsForSave — an editor that re-sends the windows it showed before a save joined them [REVIEW-M N1 on #2187]', () => {
  // The first save of LEGACY stored the joined windows; the editor still holds the pre-join pair.
  const JOINED = { durationMinutes: 60, slots: [w(1, '09:00', '12:30'), w(2, '09:00', '17:00')] };

  it('the pre-join windows, re-sent after the join: joined again, not refused', () => {
    expect(windowsForSave(LEGACY.slots, JOINED)).toEqual({ ok: true, slots: JOINED.slots });
  });

  it('the pre-join windows beside a separate new window on the same day: joined, and the new window kept', () => {
    expect(windowsForSave([...LEGACY.slots, w(1, '14:00', '17:00')], JOINED))
      .toEqual({ ok: true, slots: [w(1, '09:00', '12:30'), w(1, '14:00', '17:00'), w(2, '09:00', '17:00')] });
  });

  it('the stored time is the stored windows JOINED: against a listing that still stores its overlapping pair, a save that joins into that time is accepted', () => {
    expect(windowsForSave([w(1, '09:00', '12:30'), w(1, '10:00', '11:00')], LEGACY)).toEqual({ ok: true, slots: [w(1, '09:00', '12:30')] });
  });

  it('two overlapping windows inside the stored time that join into something else are a NEW overlap: refused', () => {
    expect(windowsForSave([w(2, '09:00', '12:00'), w(2, '11:00', '14:00')], JOINED)).toEqual({ ok: false, pair: [w(2, '09:00', '12:00'), w(2, '11:00', '14:00')] });
  });

  it('a window reaching outside the stored time still makes a refused overlap, naming that pair', () => {
    expect(windowsForSave([...LEGACY.slots, w(2, '16:00', '18:00')], JOINED)).toEqual({ ok: false, pair: [w(2, '09:00', '17:00'), w(2, '16:00', '18:00')] });
    expect(windowsForSave([w(1, '09:00', '12:00'), w(1, '11:00', '13:00')], JOINED)).toEqual({ ok: false, pair: [w(1, '09:00', '12:00'), w(1, '11:00', '13:00')] });
    // Another day's stored time covers nothing on this day.
    expect(windowsForSave([w(3, '09:00', '12:00'), w(3, '10:00', '11:00')], JOINED)).toMatchObject({ ok: false });
  });
});

describe('joinOverlappingWindows', () => {
  it('joins chains, keeps back to back apart, keeps other days', () => {
    expect(joinOverlappingWindows([w(4, '13:00', '15:00'), w(4, '09:00', '11:00'), w(4, '10:00', '13:30'), w(4, '15:00', '16:00'), w(0, '08:00', '09:00')]))
      .toEqual([w(0, '08:00', '09:00'), w(4, '09:00', '15:00'), w(4, '15:00', '16:00')]);
    expect(joinOverlappingWindows([w(5, '09:00', '17:00'), w(5, '10:00', '11:00')])).toEqual([w(5, '09:00', '17:00')]);
  });
});

describe('peakMoment', () => {
  const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 29, h, m));
  it('the most held at once, and when; back to back never stacks', () => {
    expect(peakMoment([])).toEqual({ count: 0, at: null });
    expect(peakMoment([{ start: t(10), end: t(11) }, { start: t(11), end: t(12) }])).toEqual({ count: 1, at: t(10) });
    expect(peakMoment([{ start: t(10), end: t(11) }, { start: t(10, 30), end: t(12) }, { start: t(10, 45), end: t(11, 15) }]))
      .toEqual({ count: 3, at: t(10, 45) });
  });
});
