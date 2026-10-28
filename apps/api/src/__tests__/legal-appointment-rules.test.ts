import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PRIVACY, TERMS, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import {
  APPOINTMENT_FREE_CANCEL_BEFORE_MIN,
  FREE_CANCEL_WINDOW_MIN,
  appointmentChangeCutoff,
  cancellationVerdict,
  freeCancellationExpiresAt,
  type CancellationSnapshot,
} from '../modules/order/cancel-policy';
import { BookingService, RESCHEDULE_CUTOFF_CODE, RESCHEDULE_CUTOFF_MESSAGE } from '../modules/booking/booking.service';

// ---------------------------------------------------------------------------
// [BOOK-S7 · owner rulings 28 Oct 2026 A3/A4, B1-B3, C2] THE APPOINTMENT RULES, IN WORDS AND IN CODE.
//
// The owner ruled: an appointment is free to cancel until 2 hours before it starts (COORD floor: never less than one
// minute after it was confirmed), the customer may move it until the same cutoff, a no-show is recorded with no fee
// and no strike while a person reviews repeats, and an instant booking is the business's standing acceptance. The code
// applies the cancel and move rules only while INSTANT_BOOKING is switched on, so every served sentence must be true
// with the switch on AND off: the two-hour rule is stated only under "while Swift's instant appointment booking is
// switched on", and the one-minute booking rule stays stated for the rest.
//
// This file holds the words to the numbers the server enforces (cancel-policy.ts), so a later change to either side
// fails here. Rides and parcels keep the one-minute rule, unchanged.
// ---------------------------------------------------------------------------

const HOURS = APPOINTMENT_FREE_CANCEL_BEFORE_MIN / 60;
const WORD: Record<number, string> = { 1: 'one', 2: 'two' };
const section = (html: string, heading: RegExp) => {
  const m = new RegExp(`<h2>${heading.source}</h2>\\s*<p>([\\s\\S]*?)</p>`).exec(html);
  if (!m) throw new Error(`section ${heading} not found`);
  return m[1]!;
};
const TERMS_S5 = section(TERMS, /5\. Placing an Order/);
const TERMS_S6 = section(TERMS, /6\. Paying at Handover/);
const TERMS_S7 = section(TERMS, /7\. Cancellations and refunds/);
const PRIVACY_S6 = section(PRIVACY, /6\. Retention and deletion/);
const BUSINESS_S5 = section(VENDOR_AGREEMENT, /5\. Fulfilment duties/);
const read = (...p: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...p), 'utf8');
const REFUNDS = read('web', 'src', 'app', 'legal', 'refunds', 'page.tsx').replace(/\s+/g, ' ');
const WEB_FAQ = read('web', 'src', 'lib', 'cancel-policy-copy.ts').replace(/\s+/g, ' ');
const APP_FAQ = read('mobile', 'src', 'lib', 'cancelPolicyCopy.ts').replace(/\s+/g, ' ');

describe('[BOOK-S7] the code numbers the words name', () => {
  it('two hours before the start, never less than one minute after confirmation', () => {
    expect(APPOINTMENT_FREE_CANCEL_BEFORE_MIN).toBe(120);
    expect(FREE_CANCEL_WINDOW_MIN).toBe(1);
    expect(Number.isInteger(HOURS)).toBe(true);
  });
});

describe('[BOOK-S7] Terms section 7 states the appointment rule the server applies, true with the switch on or off', () => {
  it('names the cutoff from the constants, only while instant appointment booking is switched on', () => {
    expect(TERMS_S7).toContain(
      `While Swift's instant appointment booking is switched on, an appointment the Business has confirmed (by accepting it, or automatically when you booked it) can be cancelled free in the app until ${HOURS} hours before it starts, and always for at least ${WORD[FREE_CANCEL_WINDOW_MIN]} minute after it was confirmed, instead of the ${WORD[FREE_CANCEL_WINDOW_MIN]} minute above;`,
    );
    // The hours appear once, inside the switched-on sentence: never as an unconditional promise.
    expect(TERMS_S7.match(/\d+ hours?/g)).toEqual([`${HOURS} hours`]);
    const sentence = TERMS_S7.split(/(?<=[.;])\s/).find((s) => s.includes(`${HOURS} hours`))!;
    expect(sentence).toMatch(/^While Swift's instant appointment booking is switched on,/);
  });

  it('the move (reschedule) has the same cutoff, only where the app offers it; after the cutoff, contact the Business', () => {
    expect(TERMS_S7).toContain('where the app offers it, you can also move it to another free time of the same service until that same cutoff. After the cutoff, contact the Business to change or cancel it.');
    expect(TERMS_S7).toContain('The Business can also move your appointment, and you are told in the app when it does.');
  });

  it('rides, parcels and bookings outside that rule keep the one-minute window (unchanged)', () => {
    expect(TERMS_S7).toContain(`A ride, a parcel or a booking can be cancelled free at any time while nobody has accepted it, and for ${WORD[FREE_CANCEL_WINDOW_MIN]} minute after a driver, rider or provider accepts it; after that, contact your driver, rider or provider.`);
  });

  it('no five-minute window anywhere a customer reads the rules', () => {
    for (const [name, text] of [['Terms', TERMS], ['Privacy', PRIVACY], ['Business Agreement', VENDOR_AGREEMENT], ['refunds page', REFUNDS], ['web FAQ', WEB_FAQ], ['app FAQ', APP_FAQ]] as const) {
      expect(text, name).not.toMatch(/\b(5|five)[ -]minutes?\b/i);
    }
  });
});

describe('[BOOK-S7] the refunds page and both FAQ answers say the same rule, from the same numbers', () => {
  it('refunds page', () => {
    expect(REFUNDS).toContain(`appointment booking is switched on, an appointment the business has confirmed can be cancelled free in the app until ${HOURS} hours before it starts, and always for at least ${FREE_CANCEL_WINDOW_MIN} minute after it was confirmed.`);
    expect(REFUNDS).toContain('Where the app offers it, you can also move it to another free time of the same service until then. After that, contact the business to change or cancel it.');
    expect(REFUNDS).toContain(`and for ${FREE_CANCEL_WINDOW_MIN} minute after a driver, rider or provider accepts them.`);
  });

  it.each([['web FAQ', WEB_FAQ], ['app FAQ', APP_FAQ]])('%s', (_name, text) => {
    expect(text).toContain(`While instant appointment booking is switched on, an appointment the business has confirmed can be cancelled free until ${HOURS} hours before it starts (and always for ${FREE_CANCEL_WINDOW_MIN} minute after it was confirmed); after that, contact the business.`);
  });
});

describe('[BOOK-S7] instant confirmation, missed appointments, the business\'s duty, the record kept', () => {
  it('Terms 5: a booking the app shows as confirmed when it is made was accepted in advance by the business\'s setting', () => {
    expect(TERMS_S5).toContain("A Business can set a bookable service to confirm bookings automatically: if the app shows your booking as confirmed the moment you book it, that is the Business's acceptance, given in advance through that setting, and the contract forms at that moment.");
    // The general rule stays first: an Order is an offer the Business accepts.
    expect(TERMS_S5).toMatch(/^Submitting an Order is an offer to the Business; the contract forms when the Business accepts it in the app\./);
  });

  it('Terms 6: a missed appointment carries no fee and no strike; a person reviews repeats', () => {
    expect(TERMS_S6).toContain('If a Business records in the app that you did not come to an appointment you booked, that record carries no fee and no strike; a person at Swift reviews repeated missed appointments and may contact you about them.');
  });

  it('Privacy 6: what the missed-appointment record holds, why, and how long (with its order\'s record)', () => {
    expect(PRIVACY_S6).toContain("If a Business records that a customer did not come to an appointment, Swift keeps that record (which booking it was, and when the Business recorded it) with its order's record, for as long as that order's record is kept, so that a person at Swift can review repeated missed appointments; it carries no fee or strike.");
    // The retention it borrows is the order record's own, stated in the same section.
    expect(PRIVACY_S6).toContain('Order, ride and settlement history is retained for the period required for disputes, guarantees, tax and legal obligations');
  });

  it('Business Agreement 5: keep availability current, honour bookings, or cancel in the app with a reason', () => {
    expect(BUSINESS_S5).toContain('If you list bookable services, keep your published availability (days, hours and time off) current, because customers book the times it allows. Honour every booking you accept, and every booking the app confirms for you when you set a service to confirm bookings automatically; if you cannot, cancel it in the app as early as you can, with your reason, so the customer is told.');
  });
});

// ---------------------------------------------------------------------------
// The server side of the same words: the one cancel predicate and the customer's own move.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-28T15:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(NOW.getTime() + m * MIN);
const appointment = (slotIn: number, confirmedAgo: number): CancellationSnapshot => ({
  status: 'ACCEPTED', orderType: 'FOOD_DELIVERY', fulfillment: 'APPOINTMENT',
  placedAt: at(-confirmedAgo - 5), acceptedAt: at(-confirmedAgo), holdExpiresAt: null, riderId: null, driverId: null,
  scheduledFor: null, appointmentSlot: at(slotIn),
});

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('[BOOK-S7 · B1] the cancel verdict at the cutoff the Terms name (switch on)', () => {
  it('free one minute before the cutoff and at it; refused one minute after, in words that send the customer to the business', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    const slotIn = 5 * 60; // starts in 5 hours, confirmed an hour ago
    const order = appointment(slotIn, 60);
    const cutoff = at(slotIn - APPOINTMENT_FREE_CANCEL_BEFORE_MIN);
    expect(cancellationVerdict(order, new Date(cutoff.getTime() - MIN))).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(cancellationVerdict(order, cutoff)).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    const after = cancellationVerdict(order, new Date(cutoff.getTime() + MIN));
    expect(after).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
    expect(after.allowed === false && after.message).toBe(`This booking can no longer be cancelled in the app: it starts in less than ${HOURS} hours. Contact the provider to change or cancel it.`);
  });

  it('the floor: a booking confirmed close to its time is free for one minute after the confirmation, then refused', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    const order = appointment(30, 0); // confirmed now, starts in 30 minutes
    expect(cancellationVerdict(order, at(FREE_CANCEL_WINDOW_MIN))).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(cancellationVerdict(order, new Date(at(FREE_CANCEL_WINDOW_MIN).getTime() + 1000))).toMatchObject({ allowed: false });
  });

  it('one number: the countdown the app is given is the shared cutoff', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    for (const [slotIn, ago] of [[300, 60], [30, 0], [121, 0], [119, 0]] as const) {
      const order = appointment(slotIn, ago);
      expect(freeCancellationExpiresAt(order, NOW)?.toISOString(), `${slotIn}/${ago}`).toBe(appointmentChangeCutoff(order.appointmentSlot!, order.acceptedAt!).toISOString());
    }
  });

  it('control — switch off: the one-minute booking rule the Terms state for that state', () => {
    vi.stubEnv('INSTANT_BOOKING', '');
    const order = appointment(5 * 60, 0);
    expect(cancellationVerdict(order, at(FREE_CANCEL_WINDOW_MIN))).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(cancellationVerdict(order, at(FREE_CANCEL_WINDOW_MIN + 1))).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
  });
});

// The customer's own move (POST /customer/bookings/:id/reschedule → BookingService.rescheduleBooking), graded on
// doubles: the cutoff is read under the order lock, and a refused move writes nothing.
function harness(order: { status: string; acceptedAt: Date | null; placedAt: Date }, slotIn: number) {
  const writes: string[] = [];
  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 1,
    booking: {
      create: async (args: { data: Record<string, unknown> }) => { writes.push('booking.create'); return { id: 'booking-2', ...args.data }; },
      updateMany: async () => { writes.push('booking.updateMany'); return { count: 1 }; },
      findMany: async () => [],
    },
    vendor: { findUnique: async () => ({ bookingCapacity: 1 }) },
    order: {
      findUniqueOrThrow: async () => order,
      update: async () => { writes.push('order.update'); return {}; },
    },
  };
  const prisma = {
    booking: {
      findUnique: async () => ({
        id: 'booking-1', itemId: 'item-1', customerId: 'user-1', orderId: 'order-1', status: order.status === 'PENDING' ? 'RESERVED' : 'CONFIRMED',
        slotStart: at(slotIn), slotEnd: at(slotIn + 30), item: { id: 'item-1', vendorId: 'vendor-1', name: 'Cut' },
      }),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  vi.spyOn(BookingService.prototype as unknown as { validatedSlot: () => Promise<unknown> }, 'validatedSlot')
    .mockResolvedValue({ config: { durationMinutes: 30, slots: [] }, vendorId: 'vendor-1' });
  return { svc: new BookingService(prisma), writes };
}
const accepted = (ago: number) => ({ status: 'ACCEPTED', acceptedAt: at(-ago), placedAt: at(-ago - 5) });
const TARGET = at(24 * 60);

describe('[BOOK-S7 · B2] the customer moves a confirmed appointment only until the same cutoff (switch on)', () => {
  const frozen = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); };

  it('inside the last two hours: refused in plain words, nothing written', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const h = harness(accepted(60), APPOINTMENT_FREE_CANCEL_BEFORE_MIN - 30);
    await expect(h.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).rejects.toMatchObject({
      statusCode: 409, code: RESCHEDULE_CUTOFF_CODE, message: RESCHEDULE_CUTOFF_MESSAGE,
    });
    expect(RESCHEDULE_CUTOFF_MESSAGE).toBe(`This booking can no longer be moved in the app: it starts in less than ${HOURS} hours. Contact the provider to change or cancel it.`);
    expect(h.writes).toEqual([]);
  });

  it('before the cutoff: moved', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const h = harness(accepted(60), APPOINTMENT_FREE_CANCEL_BEFORE_MIN + 1);
    expect((await h.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).moved).toBe(true);
    expect(h.writes).toEqual(['booking.updateMany', 'booking.create', 'order.update']);
  });

  it('the floor: within one minute of the confirmation it still moves; after that minute, refused', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    expect((await harness({ status: 'ACCEPTED', acceptedAt: NOW, placedAt: at(-1) }, 30).svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).moved).toBe(true);
    await expect(harness(accepted(FREE_CANCEL_WINDOW_MIN + 1), 30).svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' }))
      .rejects.toMatchObject({ code: RESCHEDULE_CUTOFF_CODE });
  });

  it('a request the business has not confirmed yet moves freely, as it cancels freely', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const h = harness({ status: 'PENDING', acceptedAt: null, placedAt: at(-5) }, 30);
    expect((await h.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).moved).toBe(true);
  });

  it('the business may still move it inside the last two hours (owner B2: the business can reschedule too)', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const h = harness(accepted(60), 30);
    expect((await h.svc.rescheduleBooking('booking-1', TARGET, { vendorId: 'vendor-1' })).moved).toBe(true);
  });

  it('control — switch off: today\'s move, with no cutoff', async () => {
    vi.stubEnv('INSTANT_BOOKING', ''); frozen();
    const h = harness(accepted(60), 30);
    expect((await h.svc.rescheduleBooking('booking-1', TARGET, { customerId: 'user-1' })).moved).toBe(true);
  });
});
