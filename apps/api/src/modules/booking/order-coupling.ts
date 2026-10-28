import type { Prisma, PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// [BOOK-S2] THE ONE COUPLING SEAM between an appointment order and its booking.
//
// An order's booking follows its order, in the same commit, through this one
// function and nowhere else:
//   - the business accepts           -> a RESERVED booking becomes CONFIRMED;
//   - the appointment completes      -> the booking is COMPLETED;
//   - the order dies (the business rejects, the no-response auto-cancel, the
//     customer cancels, an admin or ops cancel, the unpaid-MMG expiry) -> the
//     booking is CANCELLED, which gives the business its time back at once (no
//     booking rule counts a CANCELLED row [BOOK-S1]).
// Only a live booking (RESERVED or CONFIRMED) is ever moved: a completed
// booking is a record, and stays one.
//
// Callers: the canonical order transition (order.service.ts
// stageCanonicalOrderTransition: accept, complete, reject, auto-cancel, admin
// and ops cancels, the unpaid-MMG expiry), the customer's own cancel
// (cancelOrder) and the legacy no-response cleanup
// (applyCancellationSideEffects).
// ---------------------------------------------------------------------------

export type OrderBookingChange = 'CONFIRM' | 'COMPLETE' | 'FREE';

const LIVE_BOOKING = ['RESERVED', 'CONFIRMED'] as const;

/** What an order transition does to the order's booking (null = nothing). */
export function bookingChangeForOrderTransition(
  target: string,
  cancellation: boolean,
): OrderBookingChange | null {
  if (cancellation) return 'FREE';
  if (target === 'COMPLETED') return 'COMPLETE';
  if (target === 'ACCEPTED') return 'CONFIRM';
  return null;
}

/** Apply the change to every live booking of the order, on the caller's transaction. */
export async function syncOrderBookings(
  db: Prisma.TransactionClient | PrismaClient,
  orderId: string,
  change: OrderBookingChange,
): Promise<number> {
  const moved = change === 'CONFIRM'
    ? await db.booking.updateMany({ where: { orderId, status: 'RESERVED' }, data: { status: 'CONFIRMED' } })
    : await db.booking.updateMany({
        where: { orderId, status: { in: [...LIVE_BOOKING] } },
        data: { status: change === 'COMPLETE' ? 'COMPLETED' : 'CANCELLED' },
      });
  return moved.count;
}
