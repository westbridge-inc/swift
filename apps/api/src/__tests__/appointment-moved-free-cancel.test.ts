import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, UserRole } from '@prisma/client';
import { LEGAL_VERSION, TERMS } from '../modules/legal/legal.routes';
import { acceptanceStatus, NON_MATERIAL_CHANGES, MATERIAL_CHANGES } from '../modules/legal/reaccept';
import { BookingService } from '../modules/booking/booking.service';
import {
  APPOINTMENT_FREE_CANCEL_BEFORE_MIN,
  APPOINTMENT_MOVED_FREE_CANCEL_MIN,
  cancellationVerdict,
  freeCancellationExpiresAt,
  movedAppointmentFreeCancelEnd,
  serviceAppointmentCancelView,
  serviceJobCancelVerdict,
  type CancellationSnapshot,
} from '../modules/order/cancel-policy';

// ---------------------------------------------------------------------------
// [BOOK-P3 · COORD ruling 29 Oct 2026 (b)] WHEN THE BUSINESS OR PROVIDER MOVES A CONFIRMED APPOINTMENT, the
// customer — who did not choose the new time — can cancel it free in the app for 60 minutes after being told
// (APPOINTMENT_MOVED_FREE_CANCEL_MIN), or until it starts if that is sooner, even inside the 2-hour cut-off. Store
// appointments (orders.appointmentMovedAt, written by the business's move) and times booked from a pro's list
// (service_jobs.providerMovedAt, written by the provider's move) alike; only while INSTANT_BOOKING is on; never a fee.
// Terms s7 (LEGAL_VERSION 2026-10-29.1, non-material), the refunds page and both FAQs say it from the same number.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-02T15:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(NOW.getTime() + m * MIN);
const N = APPOINTMENT_MOVED_FREE_CANCEL_MIN;

const storeAppointment = (slotIn: number, movedAgo: number | null): CancellationSnapshot => ({
  status: 'ACCEPTED', orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT',
  placedAt: at(-24 * 60), acceptedAt: at(-23 * 60), holdExpiresAt: null, riderId: null, driverId: null,
  scheduledFor: null, appointmentSlot: at(slotIn), appointmentMovedAt: movedAgo == null ? null : at(-movedAgo),
});
const proJob = (slotIn: number, movedAgo: number | null, status = 'SCHEDULED') => ({
  status, offeringId: 'off-1', scheduledFor: at(slotIn), providerConfirmedAt: at(-24 * 60), providerMovedAt: movedAgo == null ? null : at(-movedAgo),
});

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the number', () => {
  it('is 60 minutes, and longer than the 1-minute floor it adds to', () => {
    expect(N).toBe(60);
  });
});

describe('a STORE appointment the business moved (switch on)', () => {
  it('inside the 2-hour cut-off: free for 60 minutes after the move, the countdown names that moment, then refused', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    expect(cancellationVerdict(storeAppointment(90, null), NOW)).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    const moved = storeAppointment(90, 10);
    expect(cancellationVerdict(moved, NOW)).toMatchObject({ allowed: true, free: true, reason: 'IN_WINDOW' });
    expect(freeCancellationExpiresAt(moved, NOW)?.toISOString()).toBe(at(N - 10).toISOString());
    expect(cancellationVerdict(moved, at(N - 10))).toMatchObject({ allowed: true });
    expect(cancellationVerdict(moved, new Date(at(N - 10).getTime() + 1000))).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(cancellationVerdict(storeAppointment(90, N + 1), NOW)).toMatchObject({ allowed: false });
  });

  it('never past the start: moved to 30 minutes from now, free until it starts, then refused', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    const soon = storeAppointment(30, 0);
    expect(freeCancellationExpiresAt(soon, NOW)?.toISOString()).toBe(at(30).toISOString());
    expect(cancellationVerdict(soon, at(31))).toMatchObject({ allowed: false });
  });

  it('a move well ahead keeps the 2-hour rule (the later of the two)', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    expect(freeCancellationExpiresAt(storeAppointment(24 * 60, 0), NOW)?.toISOString()).toBe(at(24 * 60 - APPOINTMENT_FREE_CANCEL_BEFORE_MIN).toISOString());
  });

  it('control — switch off: a move opens nothing (the 1-minute booking rule stands)', () => {
    vi.stubEnv('INSTANT_BOOKING', '');
    expect(cancellationVerdict(storeAppointment(90, 10), NOW)).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
  });
});

describe('a time booked from a pro\'s list that the PROVIDER moved (switch on)', () => {
  it('inside the cut-off: free for 60 minutes after the move, in the view the app reads; then refused', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    expect(serviceJobCancelVerdict(proJob(90, null), NOW)).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(serviceJobCancelVerdict(proJob(90, 10), NOW)).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(serviceAppointmentCancelView(proJob(90, 10), NOW)).toMatchObject({ canCancel: true, freeCancellationExpiresAt: at(N - 10).toISOString() });
    expect(serviceJobCancelVerdict(proJob(90, 10), new Date(at(N - 10).getTime() + 1000))).toMatchObject({ allowed: false });
  });

  it('a started job is never cancelled in the app, window or not; switch off opens nothing', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    expect(serviceJobCancelVerdict(proJob(-5, 10, 'IN_PROGRESS'), NOW)).toMatchObject({ allowed: false, code: 'SERVICE_JOB_STARTED' });
    vi.stubEnv('INSTANT_BOOKING', '');
    expect(serviceJobCancelVerdict(proJob(90, 10), NOW)).toMatchObject({ allowed: false, code: 'SERVICE_JOB_BOOKED' });
  });

  it('the move notices name the same end: the later of 2 hours before the new start and the post-move window', () => {
    expect(movedAppointmentFreeCancelEnd(at(150), NOW).toISOString()).toBe(at(N).toISOString());
    expect(movedAppointmentFreeCancelEnd(at(30), NOW).toISOString()).toBe(at(30).toISOString());
    expect(movedAppointmentFreeCancelEnd(at(600), NOW).toISOString()).toBe(at(600 - APPOINTMENT_FREE_CANCEL_BEFORE_MIN).toISOString());
  });
});

// The store move (BookingService.rescheduleBooking) on doubles: who writes the stamp.
function moveHarness() {
  const orderWrites: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    booking: {
      create: async (args: { data: Record<string, unknown> }) => ({ id: 'booking-2', ...args.data }),
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [],
    },
    vendor: { findUnique: async () => ({ bookingCapacity: 1 }) },
    order: { findUniqueOrThrow: async () => ({ status: 'ACCEPTED' }), update: async (args: { data: Record<string, unknown> }) => { orderWrites.push(args.data); return {}; } },
  };
  const prisma = {
    booking: {
      findUnique: async () => ({
        id: 'booking-1', itemId: 'item-1', customerId: 'user-1', orderId: 'order-1', status: 'CONFIRMED',
        slotStart: at(24 * 60), slotEnd: at(24 * 60 + 30), item: { id: 'item-1', vendorId: 'vendor-1', name: 'Cut' },
      }),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  vi.spyOn(BookingService.prototype as unknown as { validatedSlot: () => Promise<unknown> }, 'validatedSlot')
    .mockResolvedValue({ config: { durationMinutes: 30, slots: [] }, vendorId: 'vendor-1' });
  return { svc: new BookingService(prisma), orderWrites };
}
const frozen = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); };

describe('who stamps a store appointment as moved', () => {
  it('the business\'s move (switch on): the order carries the move\'s moment, and the result hands it to the notice', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const h = moveHarness();
    const result = await h.svc.rescheduleBooking('booking-1', at(26 * 60), { vendorId: 'vendor-1' });
    expect(h.orderWrites).toEqual([{ appointmentSlot: at(26 * 60), appointmentMovedAt: NOW }]);
    expect(result.moved && result.movedByBusinessAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('the customer\'s own move stamps nothing; nor the business\'s with the switch off', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const mine = moveHarness();
    await mine.svc.rescheduleBooking('booking-1', at(26 * 60), { customerId: 'user-1' });
    expect(mine.orderWrites).toEqual([{ appointmentSlot: at(26 * 60) }]);
    vi.restoreAllMocks();
    vi.stubEnv('INSTANT_BOOKING', '');
    const off = moveHarness();
    const result = await off.svc.rescheduleBooking('booking-1', at(26 * 60), { vendorId: 'vendor-1' });
    expect(off.orderWrites).toEqual([{ appointmentSlot: at(26 * 60) }]);
    expect(result.moved && result.movedByBusinessAt).toBeNull();
  });
});

const read = (...p: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');
const section = (html: string, heading: RegExp) => new RegExp(`<h2>${heading.source}</h2>\\s*<p>([\\s\\S]*?)</p>`).exec(html)![1]!;
const TERMS_S7 = section(TERMS, /7\. Cancellations and refunds/);
const SENTENCE = `if the Business or provider moves your appointment, you can also cancel it free in the app for ${N} minutes after you are told, or until it starts if that is sooner, even within ${APPOINTMENT_FREE_CANCEL_BEFORE_MIN / 60} hours of its start.`;

describe('the words: Terms s7, the refunds page and both FAQs, from the same number', () => {
  it('Terms s7 states it once, only while instant appointment booking is switched on', () => {
    expect(TERMS_S7).toContain(`While instant appointment booking is switched on, ${SENTENCE}`);
    expect(TERMS_S7.split(`${N} minutes`).length - 1).toBe(1);
  });

  it('the refunds page and both FAQ answers say the same', () => {
    const refunds = read('web', 'src', 'app', 'legal', 'refunds', 'page.tsx').replace(/\s+/g, ' ');
    expect(refunds).toContain(`While instant appointment booking is switched on, ${SENTENCE.replace('the Business or provider', 'the business or provider')}`);
    for (const faq of [read('web', 'src', 'lib', 'cancel-policy-copy.ts'), read('mobile', 'src', 'lib', 'cancelPolicyCopy.ts')]) {
      expect(faq.replace(/\s+/g, ' ')).toContain(`and for ${N} minutes after the business or provider moves it, or until it starts if that is sooner); after that, contact the business or provider.`);
    }
  });

  it('served as 2026-10-29.1, classed non-material: nobody is asked again (a person at 2026-10-29 or 2026-10-28.1 stays)', () => {
    expect(LEGAL_VERSION).toBe('2026-10-29.1');
    expect(NON_MATERIAL_CHANGES.filter((c) => c.version === '2026-10-29.1')).toHaveLength(1);
    expect(MATERIAL_CHANGES.map((c) => c.version)).not.toContain('2026-10-29.1');
    for (const accepted of ['2026-10-29', '2026-10-28.1']) {
      expect(acceptanceStatus({ tosVersion: accepted, roles: ['CUSTOMER'] as UserRole[] }).needsAcceptance, accepted).toBe(false);
    }
  });
});
