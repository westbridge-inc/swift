import { afterEach, describe, expect, it, vi } from 'vitest';
import { appointmentReminderDedupeKey, reminderDayWord, sendBookingReminders, type BookingReminder } from '../modules/services/services.service';

// ---------------------------------------------------------------------------
// [S4 · BOOK-MEASURE R5] RIGHT SCREEN, RIGHT PERSON — the store appointment's
// 24h reminder.
//
// It was sent as { kind: 'booking_reminder', refId: <Booking id> } with no
// order and no audience. Every phone build in the stores or under review
// (build 9 a8d9fb80, build 11 437489c1, build 12 f71b89db) and main route the
// whole `booking_` prefix to ServiceJobs, the marketplace jobs list, which
// never shows a store booking: the customer and the store both tapped
// "Appointment tomorrow" and landed on a list without it. Those builds cannot
// change, so the fix is in what the server sends: a kind OUTSIDE that prefix,
// carrying the booking's orderId and the server-tagged audience, which every
// one of those builds routes through the order branches it already has
// (audience business + orderId -> the order desk; orderId -> the booking's
// order screen). The per-build replay that proves it is in the lane evidence;
// this file pins the payload contract that replay depends on.
//
// These cases run the real sweep against an in-memory double whose
// notification lookup EVALUATES the sweep's own where clause, so the dedupe is
// graded on the predicate the sweep sends, not on a stub that says "none".
// ---------------------------------------------------------------------------

type Row = { userId: string; data: Record<string, unknown>; dedupeKey: string | null };

/** The where clauses the sweep's notification lookup uses: userId, AND, OR and
 *  a one-key JSON path equality. Anything else is a tripwire, never a guess. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'userId') return row.userId === value;
    if (key === 'AND') return (value as Array<Record<string, unknown>>).every((w) => matches(row, w));
    if (key === 'OR') return (value as Array<Record<string, unknown>>).some((w) => matches(row, w));
    if (key === 'data') {
      const { path, equals, ...rest } = value as { path: string[]; equals: unknown };
      if (Object.keys(rest).length > 0 || path.length !== 1) throw new Error(`unsupported data filter ${JSON.stringify(value)}`);
      return row.data[path[0]!] === equals;
    }
    throw new Error(`unsupported notification filter key ${key}`);
  });
}

const SOON = () => new Date(Date.now() + 6 * 60 * 60 * 1000);

function storeBooking(over: Partial<{ id: string; customerId: string; ownerId: string; orderId: string | null }> = {}) {
  return {
    id: over.id ?? 'booking-1',
    customerId: over.customerId ?? 'customer-1',
    orderId: over.orderId === undefined ? 'order-1' : over.orderId,
    slotStart: SOON(),
    status: 'CONFIRMED',
    item: { name: 'Haircut', vendor: { name: 'Sharp Cuts', owner: { userId: over.ownerId ?? 'owner-1' } } },
  };
}

/** One shared inbox for the double and the delivery seam. `deliver` mirrors
 *  NotificationService.send's per-person dedupe key: a second row with the same
 *  (userId, dedupeKey) is refused and nothing new is delivered. */
function harness(bookings: ReturnType<typeof storeBooking>[], jobs: unknown[] = [], inbox: Row[] = []) {
  const delivered: BookingReminder[] = [];
  const prisma = {
    serviceJob: { findMany: async () => jobs },
    booking: { findMany: async () => bookings },
    notification: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => inbox.find((row) => matches(row, where)) ? { id: 'n' } : null,
    },
  };
  const deliver = async (n: BookingReminder) => {
    const data = n.audience ? { ...n.data, audience: n.audience } : n.data;
    if (n.dedupeKey && inbox.some((row) => row.userId === n.userId && row.dedupeKey === n.dedupeKey)) return;
    inbox.push({ userId: n.userId, data, dedupeKey: n.dedupeKey ?? null });
    delivered.push(n);
  };
  return { prisma: prisma as never, deliver, delivered, inbox };
}

describe('[S4] a store appointment reminder names the booking and whose copy it is', () => {
  it('is NOT a booking_ kind: every phone build opens the booking_ prefix on ServiceJobs, which never shows a store booking', async () => {
    const h = harness([storeBooking()]);
    await sendBookingReminders(h.prisma, h.deliver);
    expect(h.delivered).toHaveLength(2);
    for (const n of h.delivered) {
      expect(String(n.data['kind']), `${n.userId} copy`).not.toMatch(/^booking_/);
      expect(n.data['kind']).toBe('appointment_reminder');
    }
  });

  it('the customer copy carries the order and audience customer; the store copy the order and audience business', async () => {
    const h = harness([storeBooking({ id: 'booking-7', orderId: 'order-7', customerId: 'cust-7', ownerId: 'owner-7' })]);
    await sendBookingReminders(h.prisma, h.deliver);
    const customer = h.delivered.find((n) => n.userId === 'cust-7');
    const store = h.delivered.find((n) => n.userId === 'owner-7');
    expect(customer).toMatchObject({
      audience: 'customer', dedupeKey: appointmentReminderDedupeKey('booking-7'),
      data: { kind: 'appointment_reminder', bookingId: 'booking-7', orderId: 'order-7' },
    });
    expect(store).toMatchObject({
      audience: 'business', dedupeKey: appointmentReminderDedupeKey('booking-7'),
      data: { kind: 'appointment_reminder', bookingId: 'booking-7', orderId: 'order-7' },
    });
    // The customer's words did not change; the store's read naturally (REVIEW-F S4-1, pinned below).
    expect(customer!.body).toMatch(/^Haircut at Sharp Cuts is booked for /);
    expect(store!.body).toMatch(/^Haircut appointment on [A-Z][a-z]{2} at \d{1,2}:\d{2} [AP]M\.$/);
  });

  it('a confirmed booking with no order on file names no order (never an invented one) and keeps its audience', async () => {
    const h = harness([storeBooking({ orderId: null })]);
    await sendBookingReminders(h.prisma, h.deliver);
    expect(h.delivered.map((n) => [n.audience, n.data])).toEqual([
      ['customer', { kind: 'appointment_reminder', bookingId: 'booking-1' }],
      ['business', { kind: 'appointment_reminder', bookingId: 'booking-1' }],
    ]);
  });

  it('a service JOB reminder is unchanged: booking_reminder + refId, the jobs list is its screen', async () => {
    const job = { id: 'job-1', customerId: 'cust-j', scheduledFor: SOON(), provider: { userId: 'pro-j', trade: 'Plumber' } };
    const h = harness([], [job]);
    await sendBookingReminders(h.prisma, h.deliver);
    expect(h.delivered.map((n) => [n.userId, n.data, n.audience, n.dedupeKey])).toEqual([
      ['cust-j', { kind: 'booking_reminder', refId: 'job-1' }, undefined, undefined],
      ['pro-j', { kind: 'booking_reminder', refId: 'job-1' }, undefined, undefined],
    ]);
  });
});

describe('[S4] once per booking per person', () => {
  it('a second sweep reminds nobody again', async () => {
    const h = harness([storeBooking()]);
    expect(await sendBookingReminders(h.prisma, h.deliver)).toBe(2);
    expect(await sendBookingReminders(h.prisma, h.deliver)).toBe(0);
    expect(h.inbox).toHaveLength(2);
  });

  it('a booking already reminded under the old kind (booking_reminder + refId) is not reminded again after the switch', async () => {
    const h = harness([storeBooking()], [], [
      { userId: 'customer-1', data: { kind: 'booking_reminder', refId: 'booking-1' }, dedupeKey: null },
    ]);
    await sendBookingReminders(h.prisma, h.deliver);
    // Only the store, which the old sweep had not reached, is reminded.
    expect(h.delivered.map((n) => [n.userId, n.audience])).toEqual([['owner-1', 'business']]);
  });

  it('a person who is both the customer and the store owner is reminded once for that booking', async () => {
    const h = harness([storeBooking({ customerId: 'same-person', ownerId: 'same-person' })]);
    await sendBookingReminders(h.prisma, h.deliver);
    expect(h.delivered.map((n) => [n.userId, n.audience])).toEqual([['same-person', 'customer']]);
  });

  it('another booking of the same person is its own reminder; a job id is never confused with a booking id', async () => {
    const h = harness([storeBooking({ id: 'booking-a' }), storeBooking({ id: 'booking-b' })], [], [
      // A JOB reminder whose id happens to equal nothing here, and an appointment reminder for another booking.
      { userId: 'customer-1', data: { kind: 'booking_reminder', refId: 'job-x' }, dedupeKey: null },
      { userId: 'customer-1', data: { kind: 'appointment_reminder', bookingId: 'booking-z' }, dedupeKey: appointmentReminderDedupeKey('booking-z') },
    ]);
    await sendBookingReminders(h.prisma, h.deliver);
    expect(h.delivered.map((n) => [n.userId, n.data['bookingId']])).toEqual([
      ['customer-1', 'booking-a'], ['owner-1', 'booking-a'], ['customer-1', 'booking-b'], ['owner-1', 'booking-b'],
    ]);
  });

  it('two sweeps that both pass the lookup before either delivers still remind each person once (the per-person dedupe key)', async () => {
    const h = harness([storeBooking()]);
    // Both sweeps read an empty inbox (as two overlapping runs would), then both deliver.
    let lookups = 0;
    let release!: () => void;
    const bothLooked = new Promise<void>((resolve) => { release = resolve; });
    const prisma = h.prisma as unknown as { notification: { findFirst: (a: unknown) => Promise<unknown> } };
    const real = prisma.notification.findFirst;
    prisma.notification.findFirst = async (args) => {
      const seen = await real(args);
      lookups += 1;
      if (lookups === 2) release();
      await bothLooked;
      return seen;
    };
    await Promise.all([sendBookingReminders(h.prisma, h.deliver), sendBookingReminders(h.prisma, h.deliver)]);
    const perPerson = h.inbox.reduce<Record<string, number>>((acc, row) => ({ ...acc, [row.userId]: (acc[row.userId] ?? 0) + 1 }), {});
    expect(perPerson).toEqual({ 'customer-1': 1, 'owner-1': 1 });
  });
});

// [REVIEW-F S3-1] The sweep runs hourly over the next 24 hours, so a slot later
// TODAY is reminded at once: its title must not say "tomorrow". The day is the
// Guyana calendar day (UTC−4, no daylight saving) of the slot against the sweep.
describe('[S4] the reminder title names the right day, in Guyana time', () => {
  afterEach(() => vi.useRealTimers());

  /** One sweep at `nowIso` over one store booking and one service job, both at `slotIso`. */
  async function titlesAt(nowIso: string, slotIso: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nowIso));
    const slot = new Date(slotIso);
    const booking = { ...storeBooking(), slotStart: slot };
    const job = { id: 'job-1', customerId: 'cust-j', scheduledFor: slot, provider: { userId: 'pro-j', trade: 'Plumber' } };
    const h = harness([booking], [job]);
    await sendBookingReminders(h.prisma, h.deliver);
    return {
      appointment: [...new Set(h.delivered.filter((n) => n.data['kind'] === 'appointment_reminder').map((n) => n.title))],
      job: [...new Set(h.delivered.filter((n) => n.data['kind'] === 'booking_reminder').map((n) => n.title))],
      store: h.delivered.find((n) => n.audience === 'business')!.body,
    };
  }

  it('a slot later the same Guyana day says today (08:00 now, 15:00 slot)', async () => {
    const t = await titlesAt('2026-10-28T12:00:00.000Z', '2026-10-28T19:00:00.000Z');
    expect(t.appointment).toEqual(['Appointment today']);
    expect(t.job).toEqual(['Booking today']);
  });

  it('a slot on the next Guyana day says tomorrow (08:00 now, 09:00 next day)', async () => {
    const t = await titlesAt('2026-10-28T12:00:00.000Z', '2026-10-29T13:00:00.000Z');
    expect(t.appointment).toEqual(['Appointment tomorrow']);
    expect(t.job).toEqual(['Booking tomorrow']);
  });

  it('the Guyana midnight decides, not the UTC one: 23:30 now, 23:50 is today and 00:30 is tomorrow', async () => {
    // 03:30Z, 03:50Z and 04:30Z share one UTC date; in Guyana the last one is past midnight.
    expect((await titlesAt('2026-10-29T03:30:00.000Z', '2026-10-29T03:50:00.000Z')).appointment).toEqual(['Appointment today']);
    expect((await titlesAt('2026-10-29T03:30:00.000Z', '2026-10-29T04:30:00.000Z')).appointment).toEqual(['Appointment tomorrow']);
    expect((await titlesAt('2026-10-29T03:30:00.000Z', '2026-10-29T04:30:00.000Z')).job).toEqual(['Booking tomorrow']);
    // 20:00 in Guyana is already the next UTC date: a 22:00 slot is still today.
    expect((await titlesAt('2026-10-29T00:00:00.000Z', '2026-10-29T02:00:00.000Z')).appointment).toEqual(['Appointment today']);
  });

  it('the store\'s copy reads naturally: the service, the day and the time', async () => {
    const t = await titlesAt('2026-10-28T12:00:00.000Z', '2026-10-28T19:00:00.000Z');
    expect(t.store).toBe('Haircut appointment on Wed at 3:00 PM.');
  });

  it('reminderDayWord never says tomorrow for today, and falls back to "coming up" beyond tomorrow', () => {
    const now = new Date('2026-10-28T12:00:00.000Z');
    expect(reminderDayWord(new Date('2026-10-29T03:59:00.000Z'), now)).toBe('today'); // 23:59 Guyana
    expect(reminderDayWord(new Date('2026-10-29T04:00:00.000Z'), now)).toBe('tomorrow'); // 00:00 Guyana
    expect(reminderDayWord(new Date('2026-10-31T04:00:00.000Z'), now)).toBe('coming up');
  });
});
