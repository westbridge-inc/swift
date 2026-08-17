import { describe, it, expect } from 'vitest';
import {
  refundCalculator,
  refundCalculatorMinor,
  type RefundBooking,
  type RefundBookingMinor,
} from '../modules/ads/refund-calculator';

// ads-platform spec §8.4 — the refund calculator is a pure function and EVERY
// table row is a named test case. Prices are the locked booking amounts.

const WK1 = new Date('2026-08-03T00:00:00Z'); // Monday
const WK2 = new Date('2026-08-10T00:00:00Z');
const WK3 = new Date('2026-08-17T00:00:00Z');
const PRICE = 5000;

const bk = (id: string, weekStart: Date): RefundBooking => ({ id, weekStart, amount: PRICE });

describe('§8.4 refund rules — one case per table row', () => {
  it('Row 1 — auto-cancel (creatives never approved): 100% of every week', () => {
    // now is before all weeks (autoCancel fires before startWeek).
    const now = new Date('2026-08-01T00:00:00Z');
    const plan = refundCalculator([bk('a', WK1), bk('b', WK2)], 'AUTO_CANCEL_UNAPPROVED', { now });
    expect(plan.total).toBe(PRICE * 2);
    expect(plan.items.every((i) => i.kind === 'REFUND' && i.amount === PRICE)).toBe(true);
  });

  it('Row 2 — advertiser cancels ≥7d before a week: 100% of that week', () => {
    const now = new Date('2026-07-20T00:00:00Z'); // 14 days before WK1
    const plan = refundCalculator([bk('a', WK1)], 'ADVERTISER_CANCEL', { now, cancelFullRefundDays: 7 });
    expect(plan.items).toEqual([{ bookingId: 'a', amount: PRICE, kind: 'REFUND' }]);
  });

  it('Row 3 — advertiser cancels <7d before a week: 50% of that week', () => {
    const now = new Date('2026-07-30T00:00:00Z'); // 4 days before WK1
    const plan = refundCalculator([bk('a', WK1)], 'ADVERTISER_CANCEL', { now, cancelFullRefundDays: 7 });
    expect(plan.items).toEqual([{ bookingId: 'a', amount: PRICE * 0.5, kind: 'REFUND' }]);
  });

  it('Row 4 — advertiser cancels mid-flight: unstarted weeks 100%, current week 0%', () => {
    // now is inside WK1 (live), WK2/WK3 unstarted but <7d and ≥7d respectively.
    const now = new Date('2026-08-05T00:00:00Z'); // Wed of WK1
    const plan = refundCalculator([bk('live', WK1), bk('soon', WK2), bk('later', WK3)], 'ADVERTISER_CANCEL', { now, cancelFullRefundDays: 7 });
    const byId = Object.fromEntries(plan.items.map((i) => [i.bookingId, i]));
    expect(byId['live']).toBeUndefined(); // 0% for the live week
    expect(byId['soon']?.amount).toBe(PRICE * 0.5); // WK2 starts in 5d (<7) → 50%
    expect(byId['later']?.amount).toBe(PRICE); // WK3 starts in 12d (≥7) → 100%
  });

  it('Row 5 — admin kill: unstarted 100% (default), current 0%; withholdable', () => {
    const now = new Date('2026-08-05T00:00:00Z'); // live in WK1
    const dflt = refundCalculator([bk('live', WK1), bk('future', WK2)], 'ADMIN_KILL', { now });
    expect(dflt.items.map((i) => i.bookingId)).toEqual(['future']);
    expect(dflt.total).toBe(PRICE);
    // Configurable: withhold future refunds.
    const withheld = refundCalculator([bk('future', WK2)], 'ADMIN_KILL', { now, adminKillRefundFuture: false });
    expect(withheld.items).toHaveLength(0);
  });

  it('Row 6 — late approval: daily pro-rata CREDIT for the current week only', () => {
    const now = new Date('2026-08-06T00:00:00Z'); // Thu of WK1 — 3 full days missed
    const plan = refundCalculator([bk('live', WK1), bk('future', WK2)], 'LATE_APPROVAL', { now, missedDaysByBooking: { live: 3 } });
    expect(plan.items).toEqual([{ bookingId: 'live', amount: Math.round((PRICE / 7) * 3 * 100) / 100, kind: 'CREDIT' }]);
    // future week gets nothing from a late-approval on the live week.
  });

  it('Row 7 — placement down: daily pro-rata CREDIT per outage day', () => {
    const now = new Date('2026-08-06T00:00:00Z');
    const plan = refundCalculator([bk('live', WK1)], 'PLACEMENT_DOWN', { now, outageDaysByBooking: { live: 2 } });
    expect(plan.items).toEqual([{ bookingId: 'live', amount: Math.round((PRICE / 7) * 2 * 100) / 100, kind: 'CREDIT' }]);
  });
});

describe('§8.4 edge behaviour', () => {
  it('a past (already-consumed) week refunds nothing on an advertiser cancel', () => {
    const now = new Date('2026-08-20T00:00:00Z'); // after WK1 ended
    const plan = refundCalculator([bk('past', WK1)], 'ADVERTISER_CANCEL', { now });
    expect(plan.items).toHaveLength(0);
    expect(plan.total).toBe(0);
  });

  it('pro-rata credit never exceeds the whole week and clamps missed days to 0..7', () => {
    const now = new Date('2026-08-09T00:00:00Z'); // Sun of WK1
    const plan = refundCalculator([bk('live', WK1)], 'LATE_APPROVAL', { now, missedDaysByBooking: { live: 99 } });
    expect(plan.items[0]!.amount).toBe(PRICE); // clamped to 7/7 = full
  });

  it('amounts round to 2 decimals (GYD Decimal(12,2))', () => {
    const now = new Date('2026-08-06T00:00:00Z');
    const plan = refundCalculator([{ id: 'x', weekStart: WK1, amount: 5000 }], 'LATE_APPROVAL', { now, missedDaysByBooking: { x: 1 } });
    expect(plan.items[0]!.amount).toBe(714.29); // 5000/7 = 714.2857… → 714.29
  });
});

describe('§8.4 authoritative integer-minor calculations', () => {
  const minorBooking = (id: string, weekStart: Date, amountMinor: bigint): RefundBookingMinor => ({
    id,
    weekStart,
    amountMinor,
  });

  it('rounds an odd-cent 50% refund half-up without floating point', () => {
    const now = new Date('2026-07-30T00:00:00Z');
    const plan = refundCalculatorMinor(
      [minorBooking('odd-cent', WK1, 101n)],
      'ADVERTISER_CANCEL',
      { now, cancelFullRefundDays: 7 },
    );

    expect(plan).toEqual({
      items: [{ bookingId: 'odd-cent', amountMinor: 51n, kind: 'REFUND' }],
      totalMinor: 51n,
    });
  });

  it('allocates one seventh with one deterministic half-up rounding step', () => {
    const now = new Date('2026-08-06T00:00:00Z');
    const plan = refundCalculatorMinor(
      [minorBooking('round-down', WK1, 101n), minorBooking('round-up', WK1, 102n)],
      'LATE_APPROVAL',
      { now, missedDaysByBooking: { 'round-down': 1, 'round-up': 1 } },
    );

    expect(plan.items).toEqual([
      { bookingId: 'round-down', amountMinor: 14n, kind: 'CREDIT' },
      { bookingId: 'round-up', amountMinor: 15n, kind: 'CREDIT' },
    ]);
    expect(plan.totalMinor).toBe(29n);
  });

  it('returns the same CREDIT plan on replay and does not mutate locked amounts', () => {
    const now = new Date('2026-08-06T00:00:00Z');
    const bookings = [minorBooking('stable', WK1, 10_001n)];
    const opts = { now, outageDaysByBooking: { stable: 2 } } as const;

    const first = refundCalculatorMinor(bookings, 'PLACEMENT_DOWN', opts);
    const replay = refundCalculatorMinor(bookings, 'PLACEMENT_DOWN', opts);

    expect(first).toEqual(replay);
    expect(first).toEqual({
      items: [{ bookingId: 'stable', amountMinor: 2_857n, kind: 'CREDIT' }],
      totalMinor: 2_857n,
    });
    expect(bookings[0]!.amountMinor).toBe(10_001n);
  });
});
