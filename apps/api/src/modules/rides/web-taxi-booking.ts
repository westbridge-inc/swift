import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// [Row 117 · owner 16 Oct 2026 20:40Z] Taxi booking from the website.
//
// Built now with the phone's rules and kept OFF until it has passed the same
// safety bar as the app and a staging run; then the owner is asked to switch
// it on. While it is off a browser session is refused at the booking door
// (TAXI_MOBILE_APP_REQUIRED) exactly as before, and the website shows fare
// estimates with "Book a taxi in the Swift app".
//
// With it on, ONE thing changes: a browser session may book a ride at
// POST /rides/request, through the same gates, fare and dispatch as the
// phone. A browser booking must carry the fare it showed (the price lock) and
// an Idempotency-Key — there is no older web client to stay compatible with.
// The ride queue stays phone-only.
// ---------------------------------------------------------------------------

/** WEB_TAXI_BOOKING: on only when exactly "1" (surrounding blanks ignored). */
export function webTaxiBookingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env['WEB_TAXI_BOOKING'] ?? '').trim() === '1';
}

/** The refusal a browser session meets at a booking door the switch keeps shut. */
export function taxiMobileAppRequired(): AppError {
  return new AppError(403, 'TAXI_MOBILE_APP_REQUIRED', 'Book taxi rides in the Swift mobile app for your safety PIN and SOS.');
}

/**
 * What a browser booking must carry, judged before anything is read or claimed:
 * the fare the customer was shown (so the price shown is the price booked) and
 * one Idempotency-Key (so a retry can never book a second ride).
 */
export function assertWebBookingCarriesQuoteAndKey(expectedFare: number | undefined, key: string | null): void {
  if (expectedFare === undefined) {
    throw new AppError(400, 'EXPECTED_FARE_REQUIRED', 'Get a fare first: a ride from the website is booked only at the fare you were shown.');
  }
  if (!key) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'This booking could not be sent safely. Refresh the page and try again.');
  }
}
