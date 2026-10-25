// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026] Web taxi booking — the pure half.
//
// Booking exists on the website only while the server says so (GET
// /rides/capabilities → webBooking, answered to a browser session only while
// WEB_TAXI_BOOKING is on). The server is the gate either way: it refuses every
// browser ride request while the switch is off, books only at the fare the
// customer was shown, and runs the phone's own gates (one ride at a time,
// strikes, a banned account). [Owner ruling 24 Oct 2026] No ID on file is
// asked for a ride any more, so there is no "add your ID" answer here.
// ---------------------------------------------------------------------------

/** What the customer is told when a booking did not go through, and what the page does next. */
export interface BookingProblem {
  kind: 'fare-changed' | 'ride-in-progress' | 'booking-off' | 'unconfirmed' | 'in-flight' | 'refused';
  message: string;
  /** Keep this booking's key for the next press: the server may already hold the request. */
  keepKey: boolean;
}

const GENERIC = 'Your ride could not be booked. Try again in a moment.';

export function bookingProblem(error: unknown): BookingProblem {
  const { code, message, status } = (error ?? {}) as { code?: unknown; message?: unknown; status?: unknown };
  switch (code) {
    case 'FARE_CHANGED':
      return { kind: 'fare-changed', message: 'The fare changed since you looked. Check the new fare, then request again.', keepKey: false };
    case 'WAITING_TERMS_CHANGED':
      // Priced again like a changed fare: the new quote carries the new terms.
      return { kind: 'fare-changed', message: 'The waiting charge changed since you looked. Check the new terms, then request again.', keepKey: false };
    case 'RIDE_IN_PROGRESS':
      return { kind: 'ride-in-progress', message: 'You already have a ride in progress.', keepKey: false };
    case 'TAXI_MOBILE_APP_REQUIRED':
      return { kind: 'booking-off', message: 'Taxi booking on the website is off right now. Book a taxi in the Swift app.', keepKey: false };
    case 'DUPLICATE_REQUEST':
      return { kind: 'in-flight', message: 'This ride is already being requested — hold on.', keepKey: true };
    case 'RIDE_REQUEST_OUTCOME_UNKNOWN':
      return { kind: 'unconfirmed', message: 'We couldn’t confirm your ride. Check your orders before you try again.', keepKey: true };
    default:
      break;
  }
  // No answer at all (the connection dropped): the request may have landed,
  // so the next press reuses the key and is answered with the first answer.
  if (typeof status !== 'number') return { kind: 'unconfirmed', message: 'We couldn’t reach Swift. Check your connection and try again.', keepKey: true };
  if (status >= 500) return { kind: 'unconfirmed', message: GENERIC, keepKey: true };
  // The server's own refusals (a strike, a restricted account, a route it
  // cannot serve) are written for the customer.
  return { kind: 'refused', message: typeof message === 'string' && message.trim() ? message.trim() : GENERIC, keepKey: false };
}

/** A fresh key for one booking intent (the server accepts 8–128 characters). */
export function newBookingKey(random: Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string } = globalThis.crypto): string {
  if (typeof random.randomUUID === 'function') return `web-taxi-${random.randomUUID()}`;
  const bytes = random.getRandomValues(new Uint8Array(16));
  return `web-taxi-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
