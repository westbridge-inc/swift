// Ad refund rules as ONE pure, deterministic function (ads-platform spec §8.4).
// No I/O, no Date.now() inside — every input is explicit so the table below is
// trivially test-covered, one named case per spec row. The service layer feeds
// it booking rows and executes the returned plan atomically.

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export type RefundReason =
  | 'AUTO_CANCEL_UNAPPROVED' // creatives never approved before startWeek − autoCancelUnapprovedHours
  | 'ADVERTISER_CANCEL'
  | 'ADMIN_KILL'
  | 'LATE_APPROVAL' // operator approved a creative after the week began
  | 'PLACEMENT_DOWN'; // operator-fault outage during a live week

export type RefundKind = 'REFUND' | 'CREDIT';

export interface RefundBooking {
  id: string;
  weekStart: Date; // the Monday
  amount: number; // price LOCKED on the booking
}

export interface RefundItem {
  bookingId: string;
  amount: number;
  kind: RefundKind;
}

export interface RefundPlan {
  items: RefundItem[];
  total: number;
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

const money = (n: number) => Math.round(n * 100) / 100;

/** A booking's week phase relative to `now`. */
function phase(weekStart: Date, now: Date): 'UNSTARTED' | 'LIVE' | 'PAST' {
  const start = weekStart.getTime();
  const end = start + WEEK_MS;
  if (now.getTime() < start) return 'UNSTARTED';
  if (now.getTime() < end) return 'LIVE';
  return 'PAST';
}

export function refundCalculator(bookings: RefundBooking[], reason: RefundReason, opts: RefundOpts): RefundPlan {
  const now = opts.now;
  const fullRefundDays = opts.cancelFullRefundDays ?? 7;
  const items: RefundItem[] = [];

  const push = (bookingId: string, amount: number, kind: RefundKind) => {
    const a = money(amount);
    if (a > 0) items.push({ bookingId, amount: a, kind });
  };

  for (const b of bookings) {
    const p = phase(b.weekStart, now);

    switch (reason) {
      // Row 1 — auto-cancel before any week started: full refund of everything.
      case 'AUTO_CANCEL_UNAPPROVED':
        push(b.id, b.amount, 'REFUND');
        break;

      // Rows 2/3/4 — advertiser cancels.
      case 'ADVERTISER_CANCEL':
        if (p === 'UNSTARTED') {
          const daysUntil = (b.weekStart.getTime() - now.getTime()) / DAY_MS;
          push(b.id, daysUntil >= fullRefundDays ? b.amount : b.amount * 0.5, 'REFUND');
        }
        // LIVE → 0% (row 4); PAST → 0 (already consumed).
        break;

      // Row 5 — admin kill: unstarted 100% (configurable), current 0%.
      case 'ADMIN_KILL':
        if (p === 'UNSTARTED' && (opts.adminKillRefundFuture ?? true)) {
          push(b.id, b.amount, 'REFUND');
        }
        break;

      // Row 6 — late approval: daily pro-rata CREDIT for the current week only.
      case 'LATE_APPROVAL':
        if (p === 'LIVE') {
          const missed = opts.missedDaysByBooking?.[b.id] ?? 0;
          push(b.id, (b.amount / 7) * Math.min(7, Math.max(0, missed)), 'CREDIT');
        }
        break;

      // Row 7 — placement outage: daily pro-rata CREDIT per outage day.
      case 'PLACEMENT_DOWN': {
        const outage = opts.outageDaysByBooking?.[b.id] ?? 0;
        if (outage > 0) push(b.id, (b.amount / 7) * Math.min(7, outage), 'CREDIT');
        break;
      }
    }
  }

  return { items, total: money(items.reduce((s, i) => s + i.amount, 0)) };
}
