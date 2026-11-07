import type { Order, Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { MMG_MONEY_MOVED } from '../order/order.service';

// ---------------------------------------------------------------------------
// [BOOK-FU2 · owner B3, 28 Oct 2026] "CUSTOMER DIDN'T COME".
//
// A business taps "Customer didn't come" on an appointment it accepted (by hand, or by its "confirm bookings
// automatically" setting), once the appointment's time has started. The order closes (CANCELLED, through the one
// canonical transition, which gives the business its time back) and a record is kept with the order:
//
//   - which booking it was, when the business recorded it, and who at the business recorded it. Nothing else.
//   - no fee (Swift never charges a cancellation fee; nothing is owed), no strike (Strike is never written; the
//     customer-risk score counts only the customer's own fee-bearing cancels), and no money moves.
//   - a person at Swift reviews repeated cases (GET /admin/missed-appointments); nothing restricts the customer
//     automatically.
//
// The Terms (section 6) and the Privacy Policy (section 6) say exactly this, from LEGAL_VERSION 2026-10-28.1.
// ---------------------------------------------------------------------------

/** The order's cancellation reason and its status-log note: a sentence, so every build shows it as written. */
export const NO_SHOW_REASON = "Customer didn't come (recorded by the business).";

/** Why the business may not record a no-show on this order now, or null when it may. */
export function noShowRefusal(
  order: Pick<Order, 'fulfillment' | 'status' | 'appointmentSlot' | 'paymentMethod' | 'paymentStatus'>,
  now: Date,
): AppError | null {
  if (order.fulfillment !== 'APPOINTMENT') {
    return new AppError(400, 'NOT_AN_APPOINTMENT', 'This order is not an appointment.');
  }
  if (order.status !== 'ACCEPTED') {
    return new AppError(409, 'NO_SHOW_NOT_OPEN', 'Only a confirmed appointment that has not been completed or cancelled can be marked as "Customer didn\'t come".');
  }
  if (!order.appointmentSlot || order.appointmentSlot.getTime() > now.getTime()) {
    return new AppError(409, 'APPOINTMENT_NOT_STARTED', 'You can mark "Customer didn\'t come" once the appointment\'s time has started.');
  }
  // No money moves here: a booking already paid by MMG is settled between the business and the customer.
  if (order.paymentMethod === 'MOBILE_MONEY' && MMG_MONEY_MOVED.has(order.paymentStatus)) {
    return new AppError(409, 'NO_SHOW_PAID_MMG', 'This booking is already paid by MMG, so it cannot be closed here. Settle it with the customer directly, or contact Swift Support.');
  }
  return null;
}

/** [REVIEW-F S3-1 on #2201] The server's word for the partner app: may "Customer didn't come" be recorded on this
 *  order now (the same rule the route applies; a store under a hold is still refused by the route's operate gate).
 *  Served as `noShow: { allowed }` on the vendor order detail and the vendor bookings rows; old apps ignore it. */
export function noShowView(
  order: Pick<Order, 'fulfillment' | 'status' | 'appointmentSlot' | 'paymentMethod' | 'paymentStatus'> | null | undefined,
  now: Date,
): { allowed: boolean } {
  return { allowed: !!order && noShowRefusal(order, now) === null };
}

/**
 * Inside the canonical CANCELLED transition, on the locked order row: judge the order as it stood when the lock was
 * taken (a move or a cancel that committed first wins), then write the one record. Throws to roll the whole close
 * back. The booking is the order's booking at the order's time (the transition has just freed it).
 */
export async function recordNoShowInTransaction(
  tx: Prisma.TransactionClient,
  lockedSource: Order,
  recordedByUserId: string,
  now: Date,
): Promise<{ bookingId: string }> {
  const refusal = noShowRefusal(lockedSource, now);
  if (refusal) throw refusal;
  const booking = await tx.booking.findFirst({
    where: { orderId: lockedSource.id, slotStart: lockedSource.appointmentSlot! },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!booking) throw new AppError(409, 'NO_BOOKING', 'This appointment has no booking to close.');
  await tx.appointmentNoShow.create({
    data: { orderId: lockedSource.id, bookingId: booking.id, recordedAt: now, recordedByUserId },
  });
  return { bookingId: booking.id };
}

/** The customer's notice: neutral words, no blame, the record's consequences as the Terms state them. */
export function noShowCustomerNotice(orderNumber: string) {
  return {
    title: 'Appointment closed',
    body: `Your booking ${orderNumber} is closed: the business recorded that you didn't come. There is no fee and no strike. If that isn't right, contact Swift Support.`,
  };
}

/** The review threshold: "repeated" means at least this many. */
export const REPEAT_NO_SHOW_MIN = 2;
/** How many recent records the review reads (newest first). */
const REVIEW_WINDOW_ROWS = 5000;

/**
 * [Owner B3: a person reviews repeat cases] Customers with at least `min` missed-appointment records, most first,
 * read through each record's order (the record itself names no customer). Counts and dates only.
 */
export async function repeatNoShowCustomers(prisma: PrismaClient, min = REPEAT_NO_SHOW_MIN) {
  const rows = await prisma.appointmentNoShow.findMany({
    orderBy: { recordedAt: 'desc' },
    take: REVIEW_WINDOW_ROWS,
    select: { recordedAt: true, order: { select: { customerId: true } } },
  });
  const byCustomer = new Map<string, { count: number; lastRecordedAt: Date }>();
  for (const r of rows) {
    const seen = byCustomer.get(r.order.customerId);
    if (seen) seen.count += 1;
    else byCustomer.set(r.order.customerId, { count: 1, lastRecordedAt: r.recordedAt });
  }
  return [...byCustomer.entries()]
    .filter(([, v]) => v.count >= min)
    .sort((a, b) => b[1].count - a[1].count || b[1].lastRecordedAt.getTime() - a[1].lastRecordedAt.getTime())
    .map(([customerId, v]) => ({ customerId, missedAppointments: v.count, lastRecordedAt: v.lastRecordedAt }));
}
