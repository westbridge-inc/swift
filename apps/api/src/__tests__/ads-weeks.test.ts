import { describe, it, expect } from 'vitest';
import { mondayOf, isMonday, weeksBetween, weekCount } from '../modules/ads/ads-weeks';

// Ad week math (ads-platform spec §7.1) — unit-tested across month/year
// boundaries and the Guyana timezone edge. All week columns store the Monday.

const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe('mondayOf', () => {
  it('maps any day of a week to that week\'s Monday (Guyana TZ)', () => {
    // 2026-08-03 is a Monday. Everything Mon..Sun of that week maps to it.
    expect(ymd(mondayOf(new Date('2026-08-03T12:00:00Z')))).toBe('2026-08-03'); // Mon
    expect(ymd(mondayOf(new Date('2026-08-06T12:00:00Z')))).toBe('2026-08-03'); // Thu
    expect(ymd(mondayOf(new Date('2026-08-09T12:00:00Z')))).toBe('2026-08-03'); // Sun
    expect(ymd(mondayOf(new Date('2026-08-10T12:00:00Z')))).toBe('2026-08-10'); // next Mon
  });

  it('handles a Sunday just before midnight and a Monday just after (Guyana = UTC-4)', () => {
    // 2026-08-10 00:30 UTC is still Sun 2026-08-09 20:30 in Guyana → prior week.
    expect(ymd(mondayOf(new Date('2026-08-10T00:30:00Z')))).toBe('2026-08-03');
    // 2026-08-10 05:00 UTC is Mon 2026-08-10 01:00 Guyana → its own week.
    expect(ymd(mondayOf(new Date('2026-08-10T05:00:00Z')))).toBe('2026-08-10');
  });

  it('crosses a month boundary', () => {
    // Wed 2026-09-02 → Monday 2026-08-31.
    expect(ymd(mondayOf(new Date('2026-09-02T12:00:00Z')))).toBe('2026-08-31');
  });

  it('crosses a year boundary', () => {
    // Fri 2027-01-01 → Monday 2026-12-28.
    expect(ymd(mondayOf(new Date('2027-01-01T12:00:00Z')))).toBe('2026-12-28');
  });

  it('always returns a Monday', () => {
    for (let i = 0; i < 40; i += 1) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 9 * 86_400_000);
      expect(isMonday(mondayOf(d))).toBe(true);
    }
  });
});

describe('weeksBetween / weekCount', () => {
  it('lists every Monday inclusive', () => {
    const weeks = weeksBetween(new Date('2026-08-03'), new Date('2026-08-24'));
    expect(weeks.map(ymd)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24']);
    expect(weekCount(new Date('2026-08-03'), new Date('2026-08-24'))).toBe(4);
  });

  it('a single-week range is one Monday', () => {
    expect(weekCount(new Date('2026-08-03'), new Date('2026-08-03'))).toBe(1);
  });

  it('crosses a year boundary correctly', () => {
    const weeks = weeksBetween(new Date('2026-12-28'), new Date('2027-01-11'));
    expect(weeks.map(ymd)).toEqual(['2026-12-28', '2027-01-04', '2027-01-11']);
  });

  it('rejects non-Monday bounds and a backwards range', () => {
    expect(() => weeksBetween(new Date('2026-08-04'), new Date('2026-08-24'))).toThrow(/Monday/);
    expect(() => weeksBetween(new Date('2026-08-24'), new Date('2026-08-03'))).toThrow(/precedes/);
  });
});
