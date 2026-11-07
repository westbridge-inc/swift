import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NO_SHOW_WORDS, bookingNoShowOpen, msUntilStart, noShowClosedLine, noShowRefusalWords, orderNoShowOpen, serverAllowsNoShow } from './noShow';

// ---------------------------------------------------------------------------
// [BOOK-NS-APP · owner B3] "Customer didn't come" in the partner app: when the button shows (the same rule the
// server judges: an accepted appointment whose time has started), the words the store reads, the server's refusal
// words kept as written, and the closed state read from the server's answer (an answer without the new field still
// reads as closed). The route the phone calls is the server's.
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-29T15:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const appt = (extra: Record<string, unknown> = {}) => ({
  fulfillment: 'APPOINTMENT', status: 'ACCEPTED', appointmentSlot: at(-5 * MIN), paymentMethod: 'CASH', noShow: { allowed: true }, ...extra,
});
const refusal = (code: string, message: string) => Object.assign(new Error('Request failed with status code 409'), {
  response: { status: 409, data: { success: false, error: { code, message } } },
});

describe('[REVIEW-F S3-1 on #2201] the server\'s word comes first', () => {
  it('no word (an older server): no button on the order or the Schedule, whatever the order looks like', () => {
    expect(orderNoShowOpen(appt({ noShow: undefined }), NOW)).toBe(false);
    expect(bookingNoShowOpen({ status: 'CONFIRMED', orderId: 'o-1', slotStart: at(-MIN) }, NOW)).toBe(false);
  });
  it('the server says no: no button', () => {
    expect(orderNoShowOpen(appt({ noShow: { allowed: false } }), NOW)).toBe(false);
    expect(bookingNoShowOpen({ status: 'CONFIRMED', orderId: 'o-1', slotStart: at(-MIN), noShow: { allowed: false } }, NOW)).toBe(false);
  });
  it('only a true word counts (not a truthy one)', () => {
    for (const noShow of [{ allowed: 'true' }, { allowed: 1 }, { allowed: null }, {}, null, true]) {
      expect(orderNoShowOpen(appt({ noShow }), NOW), JSON.stringify(noShow)).toBe(false);
    }
    expect(serverAllowsNoShow({ noShow: { allowed: true } })).toBe(true);
    expect(serverAllowsNoShow(undefined)).toBe(false);
  });
  it('the server says yes but the order has moved on here (cancelled, not started on this clock): the app\'s rule still holds', () => {
    expect(orderNoShowOpen(appt({ status: 'CANCELLED' }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ appointmentSlot: at(MIN) }), NOW)).toBe(false);
  });
});

describe('[BOOK-NS-APP] the order: an accepted appointment whose time has started', () => {
  it('shows from the first instant of the appointment (the start itself counts)', () => {
    expect(orderNoShowOpen(appt({ appointmentSlot: at(0) }), NOW)).toBe(true);
    expect(orderNoShowOpen(appt(), NOW)).toBe(true);
    expect(orderNoShowOpen(appt({ appointmentSlot: at(-26 * 60 * MIN) }), NOW)).toBe(true);
  });
  it('not before the start', () => {
    expect(orderNoShowOpen(appt({ appointmentSlot: at(1) }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ appointmentSlot: at(30 * MIN) }), NOW)).toBe(false);
  });
  it('only an accepted appointment (not waiting, completed, cancelled, or a delivery)', () => {
    for (const status of ['PENDING', 'PLACED', 'COMPLETED', 'CANCELLED', 'CONFIRMED']) {
      expect(orderNoShowOpen(appt({ status }), NOW), status).toBe(false);
    }
    expect(orderNoShowOpen(appt({ status: 'accepted' }), NOW)).toBe(true);
    expect(orderNoShowOpen(appt({ fulfillment: 'PICKUP' }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ fulfillment: 'DELIVERY' }), NOW)).toBe(false);
  });
  it('no time on the order (or not a time): no button', () => {
    expect(orderNoShowOpen(appt({ appointmentSlot: null }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ appointmentSlot: undefined }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ appointmentSlot: 'soon' }), NOW)).toBe(false);
    expect(orderNoShowOpen(null, NOW)).toBe(false);
  });
  it('an MMG order paused for a payment review: no button (no forward work while paused)', () => {
    expect(orderNoShowOpen(appt({ paymentMethod: 'MOBILE_MONEY', mmgClaimMismatchAt: at(-60 * MIN) }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ paymentMethod: 'MOBILE_MONEY' }), NOW)).toBe(true);
  });
  it('[REVIEW-F S4-1 on #2201] paid by MMG (the server refuses it): no button; an unpaid MMG booking and cash keep it', () => {
    expect(orderNoShowOpen(appt({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED' }), NOW)).toBe(false);
    expect(orderNoShowOpen(appt({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' }), NOW)).toBe(true);
    expect(orderNoShowOpen(appt({ paymentMethod: 'CASH', paymentStatus: 'CAPTURED' }), NOW)).toBe(true);
  });
});

describe('[BOOK-NS-APP] the Schedule: a confirmed booking with its order, its time started', () => {
  const booking = (extra: Record<string, unknown> = {}) => ({ status: 'CONFIRMED', orderId: 'o-1', slotStart: at(-MIN), noShow: { allowed: true }, ...extra });
  it('shows once the time has started', () => {
    expect(bookingNoShowOpen(booking(), NOW)).toBe(true);
    expect(bookingNoShowOpen(booking({ slotStart: at(0) }), NOW)).toBe(true);
    expect(bookingNoShowOpen(booking({ slotStart: at(MIN) }), NOW)).toBe(false);
  });
  it('a reserved (not yet accepted), completed or cancelled booking: no button', () => {
    for (const status of ['RESERVED', 'COMPLETED', 'CANCELLED', 'SOMETHING_NEW']) {
      expect(bookingNoShowOpen(booking({ status }), NOW), status).toBe(false);
    }
  });
  it('a booking without an order (nothing for the server to close): no button', () => {
    expect(bookingNoShowOpen(booking({ orderId: null }), NOW)).toBe(false);
    expect(bookingNoShowOpen(booking({ orderId: '' }), NOW)).toBe(false);
    expect(bookingNoShowOpen(booking({ orderId: undefined }), NOW)).toBe(false);
  });
  it('the wait until the start', () => {
    expect(msUntilStart(at(90_000), NOW)).toBe(90_000);
    expect(msUntilStart(at(-1), NOW)).toBe(-1);
    expect(msUntilStart(null, NOW)).toBeNull();
    expect(msUntilStart('not a time', NOW)).toBeNull();
  });
});

describe('[BOOK-NS-APP] the words', () => {
  it('the button and the one confirm step, as the owner put them', () => {
    expect(NO_SHOW_WORDS.button).toBe('Customer didn’t come');
    expect(`${NO_SHOW_WORDS.confirmTitle} ${NO_SHOW_WORDS.confirmBody}`).toBe('Mark as ‘Customer didn’t come’? The booking closes. No fee, no strike.');
  });
  it('the server\'s refusals are shown exactly as it wrote them', () => {
    const words = [
      ['APPOINTMENT_NOT_STARTED', 'You can mark "Customer didn\'t come" once the appointment\'s time has started.'],
      ['NO_SHOW_NOT_OPEN', 'Only a confirmed appointment that has not been completed or cancelled can be marked as "Customer didn\'t come".'],
      ['NO_SHOW_NOT_OPEN', 'This appointment can no longer be marked as "Customer didn\'t come".'],
      ['NO_SHOW_PAID_MMG', 'This booking is already paid by MMG, so it cannot be closed here. Settle it with the customer directly, or contact Swift Support.'],
    ] as const;
    for (const [code, message] of words) expect(noShowRefusalWords(refusal(code, message)), code).toBe(message);
  });
  it('[REVIEW-F S3-1 on #2201] a server without the step (its not-found answer): one plain line, never the route text', () => {
    const missing = Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404, data: { success: false, error: { code: 'NOT_FOUND', message: 'Route PUT /api/v1/vendor/orders/o-1/no-show not found' } } },
    });
    expect(noShowRefusalWords(missing)).toBe('This isn’t available yet. Contact Swift Support if the customer didn’t come.');
    expect(noShowRefusalWords({ response: { status: 404, data: { error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found' } } } })).toBe(NO_SHOW_WORDS.notAvailable);
    const bare = Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { message: 'Route PUT:/api/v1/vendor/orders/o-1/no-show not found', statusCode: 404 } } });
    expect(noShowRefusalWords(bare)).toBe(NO_SHOW_WORDS.notAvailable);
  });
  it('another business\'s order (a 404 in the server\'s own words) and a 409 keep the server\'s words', () => {
    const notYours = Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404, data: { success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } } },
    });
    expect(noShowRefusalWords(notYours)).toBe('Order not found');
    // A 409 is a refusal whatever its words.
    expect(noShowRefusalWords(refusal('NOT_FOUND', 'Route PUT /x not found'))).toBe('Route PUT /x not found');
  });
  it('no words from the server (no connection): a plain sentence, never a code', () => {
    expect(noShowRefusalWords(new Error('Network Error'))).toBe('You appear to be offline — check your connection and try again.');
    expect(noShowRefusalWords({})).toBe(NO_SHOW_WORDS.fallback);
  });
  it('the closed state is read from the server\'s answer: when it was recorded, in Guyana time', () => {
    const answer = { id: 'o-1', status: 'CANCELLED', appointmentNoShow: { bookingId: 'b-1', recordedAt: '2026-10-29T14:42:00.000Z' } };
    expect(noShowClosedLine(answer)).toBe('Recorded at 10:42 AM: the customer didn’t come. No fee, no strike.');
  });
  it('an answer without the record (or with no time in it) still reads as closed, with no time', () => {
    const plain = 'Recorded: the customer didn’t come. No fee, no strike.';
    expect(noShowClosedLine({ id: 'o-1', status: 'CANCELLED' })).toBe(plain);
    expect(noShowClosedLine({ appointmentNoShow: null })).toBe(plain);
    expect(noShowClosedLine({ appointmentNoShow: { bookingId: 'b-1' } })).toBe(plain);
    expect(noShowClosedLine(undefined)).toBe(plain);
  });
});

describe('[BOOK-NS-APP] the phone calls the server\'s route', () => {
  it('PUT /vendor/orders/:id/no-show', () => {
    const api = readFileSync(join(process.cwd(), 'src/services/api.ts'), 'utf8');
    expect(api).toContain('markNoShow: (id: string) => api.put(`/vendor/orders/${id}/no-show`),');
  });
});
