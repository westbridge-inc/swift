import { describe, it, expect } from 'vitest';
import { refundCalculatorMinor, type RefundBookingMinor } from '../modules/ads/refund-calculator';
import { elapsedWeekDays, mondayOf } from '../modules/ads/ads-weeks';

// [ads · week edges] An ad week runs Monday 00:00 → Sunday 23:59 in Guyana
// (UTC-4, ads-weeks), and the stored Monday is a calendar date (UTC midnight of
// that day). Money decided "in the week" — a late-approval or outage credit,
// the advertiser-cancel refund and its 7-day lead, recognised revenue — is
// decided against the week's REAL bounds, the Guyana midnights. Comparing the
// stored date as an instant ended the week at Sunday 20:00 in Guyana: from
// then to midnight the live week read PAST (no credit) and the next one LIVE
// (no refund). Main went red on exactly that window (Mon 00:00–04:00Z).

const WK1 = new Date('2026-10-12T00:00:00Z'); // Monday 12 Oct (stored)
const WK2 = new Date('2026-10-19T00:00:00Z'); // Monday 19 Oct (stored)
const SUN_21_GY = new Date('2026-10-19T01:00:00Z'); // Mon 01:00Z = Sun 18 Oct 21:00 Guyana
const SUN_2359_GY = new Date('2026-10-19T03:59:00Z'); // Sun 18 Oct 23:59 Guyana
const MON_0000_GY = new Date('2026-10-19T04:00:00Z'); // Mon 19 Oct 00:00 Guyana
const PRICE = 700_000n; // 7,000.00
const bk = (id: string, weekStart: Date): RefundBookingMinor => ({ id, weekStart, amountMinor: PRICE });

describe('[ads] a week is Monday 00:00 to Sunday 23:59 in Guyana', () => {
  it('the instants this file uses are where it says they are', () => {
    expect(mondayOf(SUN_21_GY).toISOString()).toBe(WK1.toISOString());
    expect(mondayOf(SUN_2359_GY).toISOString()).toBe(WK1.toISOString());
    expect(mondayOf(MON_0000_GY).toISOString()).toBe(WK2.toISOString());
  });

  it('Sunday evening in Guyana (Mon 01:00Z) and Sunday 23:59: the week is still live, a late approval still credits it', () => {
    for (const now of [SUN_21_GY, SUN_2359_GY]) {
      const plan = refundCalculatorMinor([bk('live', WK1)], 'LATE_APPROVAL', { now, missedDaysByBooking: { live: 2 } });
      expect(plan.items, now.toISOString()).toEqual([{ bookingId: 'live', amountMinor: 200_000n, kind: 'CREDIT' }]);
      const outage = refundCalculatorMinor([bk('live', WK1)], 'PLACEMENT_DOWN', { now, outageDaysByBooking: { live: 1 } });
      expect(outage.totalMinor, now.toISOString()).toBe(100_000n);
    }
    // Monday 00:00 in Guyana: the week is over, nothing more is credited to it.
    expect(refundCalculatorMinor([bk('live', WK1)], 'LATE_APPROVAL', { now: MON_0000_GY, missedDaysByBooking: { live: 2 } }).items).toEqual([]);
  });

  it('Sunday evening in Guyana: the next week has not begun — a kill refunds it, a cancel refunds half', () => {
    const killed = refundCalculatorMinor([bk('next', WK2)], 'ADMIN_KILL', { now: SUN_21_GY });
    expect(killed.items).toEqual([{ bookingId: 'next', amountMinor: PRICE, kind: 'REFUND' }]);
    const cancelled = refundCalculatorMinor([bk('next', WK2)], 'ADVERTISER_CANCEL', { now: SUN_2359_GY, cancelFullRefundDays: 7 });
    expect(cancelled.items).toEqual([{ bookingId: 'next', amountMinor: PRICE / 2n, kind: 'REFUND' }]);
    // Once it has begun in Guyana, the live week refunds nothing.
    expect(refundCalculatorMinor([bk('next', WK2)], 'ADVERTISER_CANCEL', { now: MON_0000_GY }).items).toEqual([]);
  });

  it('the 7-day full-refund lead is measured to Monday 00:00 in Guyana', () => {
    const sevenDaysBefore = new Date(MON_0000_GY.getTime() - 7 * 86_400_000); // Mon 12 Oct 00:00 Guyana
    const full = refundCalculatorMinor([bk('next', WK2)], 'ADVERTISER_CANCEL', { now: sevenDaysBefore, cancelFullRefundDays: 7 });
    expect(full.items).toEqual([{ bookingId: 'next', amountMinor: PRICE, kind: 'REFUND' }]);
    const late = refundCalculatorMinor([bk('next', WK2)], 'ADVERTISER_CANCEL', { now: new Date(sevenDaysBefore.getTime() + 60_000), cancelFullRefundDays: 7 });
    expect(late.items).toEqual([{ bookingId: 'next', amountMinor: PRICE / 2n, kind: 'REFUND' }]);
  });

  it('recognised revenue counts whole Guyana days of the week, never a UTC midnight', () => {
    expect(elapsedWeekDays(WK1, SUN_21_GY)).toBe(6); // Sunday 21:00: six whole days served
    expect(elapsedWeekDays(WK1, SUN_2359_GY)).toBe(6);
    expect(elapsedWeekDays(WK1, MON_0000_GY)).toBe(7);
    expect(elapsedWeekDays(WK2, SUN_21_GY)).toBe(0);
    expect(elapsedWeekDays(WK1, new Date('2026-10-12T03:59:00Z'))).toBe(0); // Sunday 11 Oct 23:59 Guyana: not begun
    expect(elapsedWeekDays(WK1, new Date('2026-10-13T04:00:00Z'))).toBe(1);
    // [REVIEW-G A2] Capped at the whole week: revenue recognises amount / 7 x days, so a week long past is seven days
    // served, never more — a week after it ended, a year after.
    expect(elapsedWeekDays(WK1, new Date(MON_0000_GY.getTime() + 7 * 86_400_000))).toBe(7);
    expect(elapsedWeekDays(WK1, new Date('2027-10-12T04:00:00Z'))).toBe(7);
    expect(elapsedWeekDays(WK2, new Date(WK2.getTime() - 30 * 86_400_000))).toBe(0); // a month before it begins
  });
});
