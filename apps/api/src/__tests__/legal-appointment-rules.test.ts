import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PRIVACY, TERMS, VENDOR_AGREEMENT } from '../modules/legal/legal.routes';
import { BookingService } from '../modules/booking/booking.service';
import { CUSTOMER_RESCHEDULE_BEFORE_MIN, RESCHEDULE_WINDOW_CLOSED_CODE, RESCHEDULE_WINDOW_CLOSED_MESSAGE } from '../modules/booking/reschedule-policy';
import {
  APPOINTMENT_FREE_CANCEL_BEFORE_MIN,
  FREE_CANCEL_WINDOW_MIN,
  VERY_LATE_AFTER_MIN,
  cancellationVerdict,
  freeCancellationExpiresAt,
  type CancellationSnapshot,
} from '../modules/order/cancel-policy';

// ---------------------------------------------------------------------------
// [BOOK-S7 · owner rulings 28 Oct 2026 A3/A4, B1-B3, C2] THE APPOINTMENT RULES, IN WORDS AND IN CODE.
//
// The owner ruled: an appointment is free to cancel until 2 hours before it starts (COORD floor: never less than one
// minute after it was confirmed), the customer may move it until 2 hours before it starts (the move's own rule is
// booking/reschedule-policy.ts, #2194, with the same number), and an instant booking is the business's standing
// acceptance. (The no-show rule, B3, is worded with the feature that records it, not here: COORD 19:06Z.) The code
// applies the cancel (and, with #2194, the move) rules only while INSTANT_BOOKING is switched on, so every served sentence must be true
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
      `While Swift's instant appointment booking is switched on, an appointment the Business or provider has confirmed (by accepting it, or automatically when you booked it) can be cancelled free in the app until ${HOURS} hours before it starts, and always for at least ${WORD[FREE_CANCEL_WINDOW_MIN]} minute after it was confirmed, instead of the ${WORD[FREE_CANCEL_WINDOW_MIN]} minute above;`,
    );
    // The hours appear only inside the switched-on sentence (its cancel clause and its move clause): never as an
    // unconditional promise.
    expect(TERMS_S7.match(/\d+ hours?/g)).toEqual([`${HOURS} hours`, `${HOURS} hours`]);
    const sentences = TERMS_S7.split(/(?<=\.)\s/).filter((s) => s.includes(`${HOURS} hours`));
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatch(/^While Swift's instant appointment booking is switched on,/);
  });

  it('the move (reschedule): only where the app offers it, until the same number of hours before the start; then contact the Business or provider', () => {
    expect(TERMS_S7).toContain(`where the app offers it, you can also move it to another free time of the same service until ${HOURS} hours before it starts. After that, contact the Business or provider to change or cancel it.`);
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
    expect(REFUNDS).toContain(`appointment booking is switched on, an appointment the business or provider has confirmed can be cancelled free in the app until ${HOURS} hours before it starts, and always for at least ${FREE_CANCEL_WINDOW_MIN} minute after it was confirmed.`);
    expect(REFUNDS).toContain(`Where the app offers it, you can also move it to another free time of the same service until ${HOURS} hours before it starts. After that, contact the business or provider to change or cancel it.`);
    expect(REFUNDS).toContain(`and for ${FREE_CANCEL_WINDOW_MIN} minute after a driver, rider or provider accepts them.`);
  });

  it.each([['web FAQ', WEB_FAQ], ['app FAQ', APP_FAQ]])('%s', (_name, text) => {
    expect(text).toContain(`While instant appointment booking is switched on, an appointment the business or provider has confirmed can be cancelled free until ${HOURS} hours before it starts (and always for ${FREE_CANCEL_WINDOW_MIN} minute after it was confirmed); after that, contact the business or provider.`);
    expect(text).toContain('Any other service job can be cancelled free until it is booked.');
  });
});

// ---------------------------------------------------------------------------
// [TERMS · owner 29 Oct 2026 15:50Z · LEGAL_VERSION 2026-10-29, non-material] A TIME BOOKED FROM A PRO'S LIST.
//
// Book-a-pro (services/pro-booking.routes.ts, behind INSTANT_BOOKING) books a service job from an individual
// provider's list of services, confirmed at booking. Its cancel is order/cancel-policy.ts serviceJobCancelVerdict:
// while the switch is on, free until APPOINTMENT_FREE_CANCEL_BEFORE_MIN before the start (never less than
// FREE_CANCEL_WINDOW_MIN after it was confirmed), then refused ("contact the provider"); free again once the pro has
// not started it VERY_LATE_AFTER_MIN after the start. The customer's move stops at the same cut-off
// (CUSTOMER_RESCHEDULE_BEFORE_MIN); the pro may move it at any time and the customer gets a notice. With the switch off
// every such job keeps the quote job's rule (refused once booked), which the last sentence states. Those behaviours
// are pinned on the code by the book-a-pro tests (pro-booking.unit.test.ts, pro-booking.test.ts); here the words are
// held to the same constants, and every pro promise is held inside a switched-on sentence.
// ---------------------------------------------------------------------------

const sentencesOf = (text: string) => text.split(/(?<=\.)\s/);

describe('[TERMS 2026-10-29] Terms section 7: a time booked from a provider\'s list of services follows the appointment rule', () => {
  it('the late-provider number the words name is the code\'s', () => {
    expect(VERY_LATE_AFTER_MIN).toBe(30);
    expect(CUSTOMER_RESCHEDULE_BEFORE_MIN).toBe(APPOINTMENT_FREE_CANCEL_BEFORE_MIN);
  });

  it('an appointment includes a time booked from an individual service provider\'s list of services', () => {
    expect(TERMS_S7).toContain("An appointment is a time you book from a Business's listing or from an individual service provider's list of services.");
  });

  it('the provider\'s move and the late-provider free cancel, only while instant appointment booking is switched on', () => {
    expect(TERMS_S7).toContain(
      `While instant appointment booking is switched on, a provider can also move an appointment booked from their list of services, and you are told in the app when they do; if the provider has not started it ${VERY_LATE_AFTER_MIN} minutes after its start time, you can still cancel it free in the app.`,
    );
    // The minutes appear once, only inside that switched-on sentence: never as an unconditional promise.
    expect(TERMS_S7.match(/\d+ minutes?/g)).toEqual([`${VERY_LATE_AFTER_MIN} minutes`]);
    const late = sentencesOf(TERMS_S7).filter((x) => x.includes(`${VERY_LATE_AFTER_MIN} minutes`));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatch(/^While instant appointment booking is switched on,/);
    // Every sentence that names a provider's list of services, apart from the definition, is a switched-on sentence.
    for (const x of sentencesOf(TERMS_S7).filter((y) => y.includes('list of services') && !y.startsWith('An appointment is'))) {
      expect(x).toMatch(/^While (Swift's )?instant appointment booking is switched on,/);
    }
  });

  it('every other service job keeps the request rule: free until booked, then contact the provider (true with the switch off)', () => {
    expect(TERMS_S7).toContain('Any other service job request can be cancelled free in the app until the job is booked; once it is booked, contact the provider to change or cancel it.');
    expect(TERMS_S7).not.toContain('A service job request can be cancelled free');
  });

  it('the refunds page says the same, from the same numbers', () => {
    expect(REFUNDS).toContain("(a time you book from a business&apos;s listing or from a provider&apos;s list of services)");
    expect(REFUNDS).toContain(
      `While instant appointment booking is switched on, a provider can also move an appointment booked from their list of services, and you are told in the app when they do; if the provider has not started it ${VERY_LATE_AFTER_MIN} minutes after its start time, you can still cancel it free in the app.`,
    );
    expect(REFUNDS).toContain('<b>Any other service job</b> (a local pro you hired through the app) can be cancelled free in the app while it is a request, until the job is booked. Once it is booked, contact the provider to change or cancel it.');
  });
});

describe('[BOOK-S7] instant confirmation and the business\'s duty', () => {
  it('Terms 5: a booking the app shows as confirmed when it is made was accepted in advance by the business\'s setting', () => {
    expect(TERMS_S5).toContain("A Business can set a bookable service to confirm bookings automatically: if the app shows your booking as confirmed the moment you book it, that is the Business's acceptance, given in advance through that setting, and the contract forms at that moment.");
    // The general rule stays first: an Order is an offer the Business accepts.
    expect(TERMS_S5).toMatch(/^Submitting an Order is an offer to the Business; the contract forms when the Business accepts it in the app\./);
  });

  // [TERMS 2026-10-29 · COORD 29 Oct 16:13Z · REVIEW-G S3-1] A pro has no "confirm automatically" setting: a booking
  // from a pro's list of services is confirmed at booking (book-a-pro: SCHEDULED with providerConfirmedAt set), so s5
  // names the list itself as the provider's advance acceptance, right after the Business's setting.
  it('Terms 5: a booking from a provider\'s list of services was accepted in advance by publishing that list', () => {
    expect(TERMS_S5).toContain("that is the Business's acceptance, given in advance through that setting, and the contract forms at that moment. An individual service provider gives the same advance acceptance by publishing a list of services with bookable times: if the app shows your booking from that list as confirmed the moment you book it, that is the provider's acceptance, given in advance through that list, and the contract forms at that moment.");
  });

  // [BOOK-FU2 · owner B3 · COORD 28 Oct 19:06Z] The no-show words ship WITH the feature that creates the record
  // (PUT /vendor/orders/:id/no-show), as the material version 2026-10-28.1. The record holds exactly what Privacy 6
  // says (booking, when, who): pinned on the schema in appointment-no-show.unit.test.ts.
  it('Terms 6: a missed appointment carries no fee and no strike; a person reviews repeats', () => {
    expect(TERMS_S6).toContain('If a Business records in the app that you did not come to an appointment you booked, that record carries no fee and no strike; a person at Swift reviews repeated missed appointments and may contact you about them.');
  });

  it('Privacy 6: what the missed-appointment record holds, why, and how long (with its order\'s record)', () => {
    expect(PRIVACY_S6).toContain("If a Business records that a customer did not come to an appointment, Swift keeps that record (which booking it was, when the Business recorded it, and who at the Business recorded it) with its order's record, for as long as that order's record is kept, so that a person at Swift can review repeated missed appointments; it carries no fee or strike.");
    // The retention it borrows is the order record's own, stated in the same section.
    expect(PRIVACY_S6).toContain('Order, ride and settlement history is retained for the period required for disputes, guarantees, tax and legal obligations');
  });

  it('Business Agreement 5: keep availability current, honour bookings, or cancel in the app with a reason', () => {
    expect(BUSINESS_S5).toContain('If you list bookable services, keep your published availability (days, hours and time off) current, because customers book the times it allows. Honour every booking you accept, and every booking the app confirms for you when you set a service to confirm bookings automatically; if you cannot, cancel it in the app as early as you can, with your reason, so the customer is told.');
  });
});

// ---------------------------------------------------------------------------
// The server side of the same words: the one cancel predicate (cancel-policy.ts), and the customer's move
// (booking/reschedule-policy.ts, #2194: this branch is stacked on it, so the words and the rule ship together).
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

  it('the countdown the app is given is the rule in words: the later of 2 hours before the start and 1 minute after confirmation', () => {
    vi.stubEnv('INSTANT_BOOKING', '1');
    for (const [slotIn, ago] of [[300, 60], [30, 0], [121, 0], [119, 0]] as const) {
      const order = appointment(slotIn, ago);
      const words = Math.max(at(slotIn - APPOINTMENT_FREE_CANCEL_BEFORE_MIN).getTime(), at(-ago + FREE_CANCEL_WINDOW_MIN).getTime());
      expect(freeCancellationExpiresAt(order, NOW)?.getTime(), `${slotIn}/${ago}`).toBe(words);
    }
  });

  it('control — switch off: the one-minute booking rule the Terms state for that state', () => {
    vi.stubEnv('INSTANT_BOOKING', '');
    const order = appointment(5 * 60, 0);
    expect(cancellationVerdict(order, at(FREE_CANCEL_WINDOW_MIN))).toMatchObject({ allowed: true, reason: 'IN_WINDOW' });
    expect(cancellationVerdict(order, at(FREE_CANCEL_WINDOW_MIN + 1))).toMatchObject({ allowed: false, code: 'CANCEL_WINDOW_CLOSED' });
  });
});

// The customer's own move (POST /customer/bookings/:id/reschedule -> BookingService.rescheduleBooking), on doubles: the
// rule the Terms state ("until 2 hours before it starts", then contact the Business) is the one the server enforces.
function moveHarness(slotIn: number, bookingConfig: Record<string, unknown> | null = null) {
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
    order: { findUniqueOrThrow: async () => ({ status: 'ACCEPTED' }), update: async () => { writes.push('order.update'); return {}; } },
  };
  const prisma = {
    booking: {
      findUnique: async () => ({
        id: 'booking-1', itemId: 'item-1', customerId: 'user-1', orderId: 'order-1', status: 'CONFIRMED',
        slotStart: at(slotIn), slotEnd: at(slotIn + 30), item: { id: 'item-1', vendorId: 'vendor-1', name: 'Cut' },
      }),
    },
    item: { findUnique: async () => ({ id: 'item-1', vendorId: 'vendor-1', fulfillment: 'APPOINTMENT', isAvailable: true, bookingConfig }) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => { writes.push('$transaction'); return fn(tx); },
  } as unknown as PrismaClient;
  if (bookingConfig == null) {
    vi.spyOn(BookingService.prototype as unknown as { validatedSlot: () => Promise<unknown> }, 'validatedSlot')
      .mockResolvedValue({ config: { durationMinutes: 30, slots: [] }, vendorId: 'vendor-1' });
  } else {
    vi.spyOn(BookingService.prototype, 'exceptionsFor').mockResolvedValue([]);
  }
  return { svc: new BookingService(prisma), writes };
}
const frozen = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); };

describe('[BOOK-S7 · B2] the customer\'s move stops where the Terms say (switch on)', () => {
  it('the move rule uses the hours the Terms name, and its refusal sends the customer to the business', () => {
    expect(CUSTOMER_RESCHEDULE_BEFORE_MIN).toBe(APPOINTMENT_FREE_CANCEL_BEFORE_MIN);
    expect(RESCHEDULE_WINDOW_CLOSED_MESSAGE).toBe(`This booking can no longer be moved in the app: it starts in less than ${HOURS} hours. Contact the provider to change it.`);
    expect(TERMS_S7).toContain(`until ${CUSTOMER_RESCHEDULE_BEFORE_MIN / 60} hours before it starts. After that, contact the Business or provider to change or cancel it.`);
  });

  it('inside the last 2 hours: 409 in those words, and nothing is written', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const h = moveHarness(CUSTOMER_RESCHEDULE_BEFORE_MIN - 30);
    await expect(h.svc.rescheduleBooking('booking-1', at(24 * 60), { customerId: 'user-1' })).rejects.toMatchObject({
      statusCode: 409, code: RESCHEDULE_WINDOW_CLOSED_CODE, message: RESCHEDULE_WINDOW_CLOSED_MESSAGE,
    });
    expect(h.writes).toEqual([]);
  });

  it('control — before the cutoff the move goes through', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const h = moveHarness(CUSTOMER_RESCHEDULE_BEFORE_MIN + 30);
    expect((await h.svc.rescheduleBooking('booking-1', at(24 * 60), { customerId: 'user-1' })).moved).toBe(true);
    expect(h.writes).toEqual(['$transaction', 'booking.updateMany', 'booking.create', 'order.update']);
  });

  // [COORD 28 Oct] A moved appointment's NEW time keeps the listing's minimum notice, exactly as a new booking does:
  // the move runs the new time through the same slot check (validatedSlot -> slotFitsConfig).
  it('the new time must respect the listing\'s minimum notice, as a new booking does', async () => {
    vi.stubEnv('INSTANT_BOOKING', '1'); frozen();
    const everyDay = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '00:00', end: '23:59' }));
    const soon = moveHarness(24 * 60, { durationMinutes: 30, slots: everyDay, minNoticeMinutes: 120 });
    await expect(soon.svc.rescheduleBooking('booking-1', at(60), { customerId: 'user-1' })).rejects.toMatchObject({ statusCode: 400, code: 'SLOT_TOO_SOON' });
    expect(soon.writes).toEqual([]);
    vi.restoreAllMocks();
    const later = moveHarness(24 * 60, { durationMinutes: 30, slots: everyDay, minNoticeMinutes: 120 });
    expect((await later.svc.rescheduleBooking('booking-1', at(180), { customerId: 'user-1' })).moved).toBe(true);
  });
});
