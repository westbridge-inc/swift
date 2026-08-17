// Ad refund rules as ONE pure, deterministic function (ads-platform spec §8.4).
// No I/O, no Date.now() inside — every input is explicit so the table below is
// trivially test-covered, one named case per spec row. The service layer feeds
// it booking rows and executes the returned plan atomically.

import { divideMinorHalfUp, majorDecimalToMinor, minorToMajorString } from './ads-money';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const LEGACY_ADS_CURRENCY = 'GYD';

export type RefundReason =
  | 'AUTO_CANCEL_UNAPPROVED' // creatives never approved before startWeek − autoCancelUnapprovedHours
  | 'ADVERTISER_CANCEL'
  | 'ADMIN_KILL'
  | 'LATE_APPROVAL' // operator approved a creative after the week began
  | 'PLACEMENT_DOWN'; // operator-fault outage during a live week

export type RefundKind = 'REFUND' | 'CREDIT';

/** Authoritative calculator input. Money is exact integer minor units. */
export interface RefundBookingMinor {
  id: string;
  weekStart: Date; // the Monday
  amountMinor: bigint; // price LOCKED on the booking
}

export interface RefundItemMinor {
  bookingId: string;
  amountMinor: bigint;
  kind: RefundKind;
}

export interface RefundPlanMinor {
  items: RefundItemMinor[];
  totalMinor: bigint;
}

export interface RefundOpts {
  now: Date;
  cancelFullRefundDays?: number; // §default 7
  /** LATE_APPROVAL: full days of the current week the ad missed before approval. */
  missedDaysByBooking?: Record<string, number>;
  /** PLACEMENT_DOWN: outage days per booking during its live week. */
  outageDaysByBooking?: Record<string, number>;
  /** ADMIN_KILL default refunds future weeks; set false to withhold (configurable). */
  adminKillRefundFuture?: boolean;
}

/** @deprecated Use RefundBookingMinor and refundCalculatorMinor for authoritative work. */
export interface RefundBooking {
  id: string;
  weekStart: Date;
  amount: number;
}

/** @deprecated Use RefundItemMinor for authoritative work. */
export interface RefundItem {
  bookingId: string;
  amount: number;
  kind: RefundKind;
}

/** @deprecated Use RefundPlanMinor for authoritative work. */
export interface RefundPlan {
  items: RefundItem[];
  total: number;
}

/** A booking's week phase relative to `now`. */
function phase(weekStart: Date, now: Date): 'UNSTARTED' | 'LIVE' | 'PAST' {
  const start = weekStart.getTime();
  const end = start + WEEK_MS;
  if (now.getTime() < start) return 'UNSTARTED';
  if (now.getTime() < end) return 'LIVE';
  return 'PAST';
}

function requireNonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function boundedWeekDays(value: number | undefined, field: string): bigint {
  const days = requireNonNegativeSafeInteger(value ?? 0, field);
  return BigInt(days > 7 ? 7 : days);
}

/**
 * Authoritative refund policy calculator.
 *
 * Every monetary input, allocation, rounding decision, and total stays in
 * integer minor units. Pro-rata allocations use a single half-up rounding step.
 */
export function refundCalculatorMinor(
  bookings: RefundBookingMinor[],
  reason: RefundReason,
  opts: RefundOpts,
): RefundPlanMinor {
  const now = opts.now;
  const fullRefundDays = requireNonNegativeSafeInteger(opts.cancelFullRefundDays ?? 7, 'cancelFullRefundDays');
  const fullRefundLeadMs = fullRefundDays * DAY_MS;
  const items: RefundItemMinor[] = [];

  const push = (bookingId: string, amountMinor: bigint, kind: RefundKind) => {
    if (amountMinor < 0n) {
      throw new RangeError('Refund amount cannot be negative');
    }
    if (amountMinor > 0n) items.push({ bookingId, amountMinor, kind });
  };

  for (const booking of bookings) {
    if (booking.amountMinor < 0n) {
      throw new RangeError('Booking amount cannot be negative');
    }

    const bookingPhase = phase(booking.weekStart, now);

    switch (reason) {
      // Row 1 — auto-cancel before any week started: full refund of everything.
      case 'AUTO_CANCEL_UNAPPROVED':
        push(booking.id, booking.amountMinor, 'REFUND');
        break;

      // Rows 2/3/4 — advertiser cancels.
      case 'ADVERTISER_CANCEL':
        if (bookingPhase === 'UNSTARTED') {
          const startsAfterFullRefundWindow = booking.weekStart.getTime() - now.getTime() >= fullRefundLeadMs;
          const amountMinor = startsAfterFullRefundWindow
            ? booking.amountMinor
            : divideMinorHalfUp(booking.amountMinor, 2n);
          push(booking.id, amountMinor, 'REFUND');
        }
        // LIVE → 0% (row 4); PAST → 0 (already consumed).
        break;

      // Row 5 — admin kill: unstarted 100% (configurable), current 0%.
      case 'ADMIN_KILL':
        if (bookingPhase === 'UNSTARTED' && (opts.adminKillRefundFuture ?? true)) {
          push(booking.id, booking.amountMinor, 'REFUND');
        }
        break;

      // Row 6 — late approval: daily pro-rata CREDIT for the current week only.
      case 'LATE_APPROVAL':
        if (bookingPhase === 'LIVE') {
          const missedDays = boundedWeekDays(opts.missedDaysByBooking?.[booking.id], 'missedDaysByBooking');
          push(booking.id, divideMinorHalfUp(booking.amountMinor * missedDays, 7n), 'CREDIT');
        }
        break;

      // Row 7 — placement outage: daily pro-rata CREDIT per outage day.
      case 'PLACEMENT_DOWN': {
        const outageDays = boundedWeekDays(opts.outageDaysByBooking?.[booking.id], 'outageDaysByBooking');
        push(booking.id, divideMinorHalfUp(booking.amountMinor * outageDays, 7n), 'CREDIT');
        break;
      }
    }
  }

  return {
    items,
    totalMinor: items.reduce((sum, item) => sum + item.amountMinor, 0n),
  };
}

function legacyMajorNumberFromMinor(minor: bigint): number {
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Legacy ads money boundary cannot safely represent this amount');
  }

  // Compatibility/presentation boundary only. No policy or rounding decision is
  // made after this conversion; callers should migrate to refundCalculatorMinor.
  return Number(minorToMajorString(minor, LEGACY_ADS_CURRENCY));
}

/**
 * @deprecated Compatibility wrapper for the current service contract.
 *
 * It converts legacy major-unit numbers at the edge, delegates every
 * authoritative calculation to the bigint calculator, and converts only the
 * completed plan back for existing callers. New code must use
 * refundCalculatorMinor directly.
 */
export function refundCalculator(bookings: RefundBooking[], reason: RefundReason, opts: RefundOpts): RefundPlan {
  const exactPlan = refundCalculatorMinor(
    bookings.map((booking) => ({
      id: booking.id,
      weekStart: booking.weekStart,
      amountMinor: majorDecimalToMinor(String(booking.amount), LEGACY_ADS_CURRENCY),
    })),
    reason,
    opts,
  );

  return {
    items: exactPlan.items.map((item) => ({
      bookingId: item.bookingId,
      amount: legacyMajorNumberFromMinor(item.amountMinor),
      kind: item.kind,
    })),
    total: legacyMajorNumberFromMinor(exactPlan.totalMinor),
  };
}
