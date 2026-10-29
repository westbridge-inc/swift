/**
 * [Terms 2026-10-15 §7 · owner #46/#50, 14 Oct 23:57Z] The in-app help answer to "Can I cancel an
 * order?", in the Terms' own rule: a cancel is free or refused, never a fee.
 *  - a store order: free until the store accepts it; after that, contact the store;
 *  - a ride, parcel or booking: free while unaccepted and for 1 minute after acceptance (owner 22 Oct 2026; was 5);
 *  - [BOOK-S7] an appointment, while instant appointment booking is on: free until 2 hours before it starts
 *    (never less than 1 minute after confirmation, cancel-policy.ts APPOINTMENT_FREE_CANCEL_BEFORE_MIN);
 *  - [TERMS 29 Oct] the same appointment rule for a time booked from a provider's list of services;
 *  - any other service job: free until it is booked;
 *  - still free when no driver/rider is found or it runs very late; never once on its way;
 *  - paid by MMG and confirmed by the store: only the store cancels, and it refunds.
 * The older answer ("within the first few minutes … cancellation may not be available") described a
 * rule that no longer exists. cancelPolicyCopy.test.ts holds this text to the served Terms.
 */
export const CANCEL_ORDER_FAQ_ANSWER =
  'Yes, free, while the store hasn’t accepted your order. Once the store accepts it, it can’t be cancelled in the app: contact the store (the app shows the number it published). '
  + 'Rides, parcels and bookings can be cancelled free while nobody has accepted them, and for 1 minute after a driver, rider or provider accepts; after that, contact them. '
  // [BOOK-S7 · owner B1 28 Oct 2026] the appointment rule, true with the switch on or off (Terms §7).
  // [TERMS · owner 29 Oct 2026] the same rule for a time booked from a provider's list of services (Terms §7).
  + 'While instant appointment booking is switched on, an appointment the business or provider has confirmed can be cancelled free until 2 hours before it starts (and always for 1 minute after it was confirmed); after that, contact the business or provider. '
  + 'Any other service job can be cancelled free until it is booked. '
  + 'You can still cancel free if no driver or rider was found, or if it is running very late. Once it is on its way, it can’t be cancelled. '
  + 'If you paid by MMG and the store has confirmed your payment, ask the store to cancel: the store refunds you directly. '
  + 'Whenever an order you paid by MMG is cancelled, the store refunds you directly. '
  + 'Swift never charges a cancellation fee.';
