import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { BookingService, isTransactionConflict } from '../modules/booking/booking.service';

// ---------------------------------------------------------------------------
// [AX289 F6] A RESCHEDULE TAKES THE ORDER LOCK FIRST, AND A LOST LOCK RACE IS A
// 409, NEVER A 500.
//
// The canonical lock order is Order → Booking: the cancellation, the
// acceptance and every order transition lock the order row, then write its
// bookings. [BOOK-S1] Between the two sits the business's time lock: a
// reschedule waits on the order row, then on the business's advisory lock,
// frees its old slot, judges the new one against every live booking of the
// business, and only then writes it. The reschedule used to write its bookings first and the order
// last — the opposite order — so a reschedule and a cancellation of the same
// order could deadlock, and the reschedule mapped only P2002, so the lost race
// surfaced as a 500. appointment-times-journey.test.ts plays the interleaving
// against PostgreSQL; this pins the statement order and the error mapping
// without a service.
// ---------------------------------------------------------------------------

const ORDER_ID = 'order-1';
const BOOKING = {
  id: 'booking-1', itemId: 'item-1', customerId: 'user-1', orderId: ORDER_ID as string | null, status: 'CONFIRMED',
  slotStart: new Date('2026-10-05T13:00:00.000Z'), slotEnd: new Date('2026-10-05T13:30:00.000Z'),
  item: { id: 'item-1', vendorId: 'vendor-1', name: 'Cut' },
};
const TARGET = new Date('2026-10-05T14:00:00.000Z');

afterEach(() => { vi.restoreAllMocks(); });

function harness(opts: { orderId?: string | null; transaction?: () => Promise<unknown> } = {}) {
  const statements: Array<{ op: string; values?: unknown[] }> = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ op: `$queryRaw ${strings.join('?').replace(/\s+/g, ' ').trim()}`, values });
      return [];
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ op: `$executeRaw ${strings.join('?').replace(/\s+/g, ' ').trim()}`, values });
      return 1;
    },
    booking: {
      create: async (args: { data: Record<string, unknown> }) => { statements.push({ op: 'booking.create' }); return { id: 'booking-2', ...args.data }; },
      updateMany: async () => { statements.push({ op: 'booking.updateMany' }); return { count: 1 }; },
      findMany: async () => { statements.push({ op: 'booking.findMany' }); return []; },
    },
    vendor: {
      findUnique: async () => { statements.push({ op: 'vendor.findUnique' }); return { bookingCapacity: 1 }; },
    },
    order: {
      findUniqueOrThrow: async () => { statements.push({ op: 'order.findUniqueOrThrow' }); return { status: 'ACCEPTED' }; },
      update: async () => { statements.push({ op: 'order.update' }); return {}; },
    },
  };
  const prisma = {
    booking: { findUnique: async () => ({ ...BOOKING, orderId: opts.orderId === undefined ? ORDER_ID : opts.orderId }) },
    $transaction: opts.transaction ?? (async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  vi.spyOn(BookingService.prototype as unknown as { validatedSlot: () => Promise<unknown> }, 'validatedSlot')
    .mockResolvedValue({ config: { durationMinutes: 30, slots: [] }, vendorId: 'vendor-1' });
  return { svc: new BookingService(prisma), statements };
}

describe('BookingService.rescheduleBooking — Order → Booking, like every other writer', () => {
  it('locks the order row before it touches a booking, then the business, then moves the booking and the order', async () => {
    const h = harness();
    const res = await h.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' });
    expect(res.moved).toBe(true);
    expect(h.statements.map((s) => s.op)).toEqual([
      '$queryRaw SELECT id FROM "orders" WHERE id = ? FOR UPDATE',
      // [L09 · M018] the parent's state is read under its own lock
      'order.findUniqueOrThrow',
      // [BOOK-S1] the business's time, one writer at a time
      '$executeRaw SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
      'booking.updateMany',
      // the one overlap rule: every live booking of the business, and its capacity
      'booking.findMany',
      'vendor.findUnique',
      'booking.create',
      'order.update',
    ]);
    expect(h.statements[0]!.values).toEqual([ORDER_ID]);
    expect(h.statements[2]!.values).toEqual(['booking-business:vendor-1']);
  });

  it('control — a booking with no order has no order row to lock', async () => {
    const h = harness({ orderId: null });
    await h.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' });
    expect(h.statements.map((s) => s.op)).toEqual([
      '$executeRaw SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', 'booking.updateMany', 'booking.findMany', 'vendor.findUnique', 'booking.create',
    ]);
  });
});

describe('BookingService.rescheduleBooking — a lost lock race answers 409 BOOKING_MOVED', () => {
  const lost = [
    ['a write conflict or deadlock in the interactive transaction (P2034)', Object.assign(new Error('Transaction failed due to a write conflict or a deadlock. Please retry your transaction'), { code: 'P2034' })],
    ['a deadlock on a raw statement (P2010 · 40P01)', Object.assign(new Error('Raw query failed. Code: `40P01`. Message: `deadlock detected`'), { code: 'P2010', meta: { code: '40P01', message: 'deadlock detected' } })],
    ['a serialization failure (40001)', Object.assign(new Error('could not serialize access due to concurrent update'), { code: 'P2010', meta: { code: '40001' } })],
  ] as const;

  for (const [why, error] of lost) {
    it(`${why} → 409 BOOKING_MOVED, never a 500`, async () => {
      const h = harness({ transaction: async () => { throw error; } });
      await expect(h.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).rejects.toMatchObject({
        statusCode: 409, code: 'BOOKING_MOVED', message: 'This booking just changed — reload and try again',
      });
      expect(isTransactionConflict(error)).toBe(true);
    });
  }

  it('control — a slot taken by someone else stays SLOT_TAKEN, and an unrelated failure still surfaces', async () => {
    const taken = harness({ transaction: async () => { throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }); } });
    await expect(taken.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).rejects.toMatchObject({ statusCode: 409, code: 'SLOT_TAKEN' });
    const broken = harness({ transaction: async () => { throw new Error('connection reset'); } });
    await expect(broken.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).rejects.toThrow('connection reset');
    expect(isTransactionConflict(new Error('connection reset'))).toBe(false);
    expect(isTransactionConflict(null)).toBe(false);
  });
});
