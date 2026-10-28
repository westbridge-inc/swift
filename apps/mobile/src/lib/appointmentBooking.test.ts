import { describe, expect, it } from 'vitest';
import {
  appointmentBookingView,
  bookingSummaryNote,
  checkoutButtonLabel,
  listingConfirmsInstantly,
  mmgBookingWaitsNote,
  placedBookingOutcome,
  placedPopupTitle,
  rescheduleErrorMessage,
} from './appointmentBooking';

// [BOOK-S6a · REVIEW-F S3-1 on #2193 · owner A3/A4/B2] The customer's booking words follow the
// server's answer, never the app's guess, and degrade to "a request" when the server says nothing.

describe('the success popup follows the checkout answer', () => {
  const answer = (...orders: Array<{ fulfillment: string; status: string }>) => ({ orders, message: 'x' });

  it('an appointment that came back ACCEPTED is "Booking confirmed"', () => {
    const outcome = placedBookingOutcome(answer({ fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }));
    expect(outcome).toBe('confirmed');
    expect(placedPopupTitle({ appointment: true, outcome })).toBe('Booking confirmed');
  });

  it('an appointment that came back PENDING is "Booking requested"', () => {
    const outcome = placedBookingOutcome(answer({ fulfillment: 'APPOINTMENT', status: 'PENDING' }));
    expect(outcome).toBe('requested');
    expect(placedPopupTitle({ appointment: true, outcome })).toBe('Booking requested');
  });

  it('two bookings: confirmed only when every one is ACCEPTED', () => {
    expect(placedBookingOutcome(answer({ fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }, { fulfillment: 'APPOINTMENT', status: 'PENDING' }))).toBe('requested');
    expect(placedBookingOutcome(answer({ fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }, { fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }))).toBe('confirmed');
  });

  it('a goods order beside the booking does not decide it', () => {
    expect(placedBookingOutcome(answer({ fulfillment: 'DELIVERY', status: 'PENDING' }, { fulfillment: 'APPOINTMENT', status: 'ACCEPTED' }))).toBe('confirmed');
  });

  it('an answer naming no appointment, or none at all, is never "confirmed" for a booking cart', () => {
    for (const a of [undefined, null, {}, { orders: 'x' }, answer({ fulfillment: 'DELIVERY', status: 'ACCEPTED' })]) {
      expect(placedBookingOutcome(a)).toBeNull();
      expect(placedPopupTitle({ appointment: true, outcome: placedBookingOutcome(a) })).toBe('Booking requested');
    }
    expect(placedPopupTitle({ appointment: false, outcome: null })).toBe('Your order is placed');
  });

  it('a lower-case or odd status is a request', () => {
    expect(placedBookingOutcome(answer({ fulfillment: 'APPOINTMENT', status: 'accepted' }))).toBe('requested');
  });
});

describe('the item badge and the cart button need the server to say "instant"', () => {
  it('only instantConfirmation === true counts', () => {
    expect(listingConfirmsInstantly({ instantConfirmation: true })).toBe(true);
    for (const v of [undefined, null, {}, { instantConfirmation: 'true' }, { instantConfirmation: 1 }, { instantConfirmation: false }, { bookingConfig: { instantBooking: true } }]) {
      expect(listingConfirmsInstantly(v)).toBe(false);
    }
  });

  it('"Book now" only for instant bookings paid cash; otherwise "Request booking"', () => {
    expect(checkoutButtonLabel({ appointmentOnly: true, pickup: false, everyBookingInstant: true, payingCash: true })).toBe('Book now');
    expect(checkoutButtonLabel({ appointmentOnly: true, pickup: false, everyBookingInstant: false, payingCash: true })).toBe('Request booking');
    expect(checkoutButtonLabel({ appointmentOnly: true, pickup: false, everyBookingInstant: true, payingCash: false })).toBe('Request booking');
  });

  it('goods carts keep their words', () => {
    expect(checkoutButtonLabel({ appointmentOnly: false, pickup: false, everyBookingInstant: false, payingCash: true })).toBe('Place order');
    expect(checkoutButtonLabel({ appointmentOnly: false, pickup: true, everyBookingInstant: false, payingCash: true })).toBe('Place pickup order');
  });

  it('the booking summary says when the time is confirmed', () => {
    expect(bookingSummaryNote({ everyBookingInstant: true, payingCash: true })).toBe('Your time is confirmed as soon as you book.');
    expect(bookingSummaryNote({ everyBookingInstant: true, payingCash: false })).toBe('Your time is confirmed when the business accepts the booking.');
    expect(bookingSummaryNote({ everyBookingInstant: false, payingCash: true })).toBe('Your time is confirmed when the business accepts the booking.');
  });

  it('an instant booking paid by MMG says the business confirms first; nothing otherwise', () => {
    expect(mmgBookingWaitsNote({ appointmentOnly: true, everyBookingInstant: true, payingCash: false })).toBe('Paying by MMG: the business confirms the booking first.');
    expect(mmgBookingWaitsNote({ appointmentOnly: true, everyBookingInstant: true, payingCash: true })).toBeNull();
    expect(mmgBookingWaitsNote({ appointmentOnly: true, everyBookingInstant: false, payingCash: false })).toBeNull();
  });
});

describe('the booking screen\'s "Change time" reads the server\'s projection', () => {
  const booking = { id: 'b-1', itemId: 'i-1', slotStart: '2026-12-01T14:00:00.000Z' };

  it('allowed: shows the control', () => {
    expect(appointmentBookingView({ appointmentBooking: { ...booking, reschedule: { allowed: true, message: null } } })).toEqual({
      bookingId: 'b-1', itemId: 'i-1', slotStart: '2026-12-01T14:00:00.000Z', canReschedule: true, rescheduleUnavailable: null,
    });
  });

  it('refused: the server\'s own words, no control', () => {
    const v = appointmentBookingView({ appointmentBooking: { ...booking, reschedule: { allowed: false, message: 'It starts in less than 2 hours.' } } });
    expect(v?.canReschedule).toBe(false);
    expect(v?.rescheduleUnavailable).toBe('It starts in less than 2 hours.');
  });

  it('an older server (no field), a broken shape, or no reschedule block: no control', () => {
    expect(appointmentBookingView({})).toBeNull();
    expect(appointmentBookingView(null)).toBeNull();
    expect(appointmentBookingView({ appointmentBooking: { itemId: 'i-1', slotStart: 'x' } })).toBeNull();
    const bare = appointmentBookingView({ appointmentBooking: booking });
    expect(bare?.canReschedule).toBe(false);
    expect(bare?.rescheduleUnavailable).toBeNull();
    expect(appointmentBookingView({ appointmentBooking: { ...booking, reschedule: { allowed: 'yes' } } })?.canReschedule).toBe(false);
  });

  it('a refused move shows the server\'s message, else a plain retry line', () => {
    expect(rescheduleErrorMessage({ response: { data: { error: { message: 'That time was just taken.' } } } })).toBe('That time was just taken.');
    expect(rescheduleErrorMessage(new Error('Network Error'))).toBe('Couldn’t change the time. Check your connection and try again.');
  });
});
