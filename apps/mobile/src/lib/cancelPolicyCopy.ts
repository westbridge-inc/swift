/**
 * [Terms 2026-10-15 §7 · owner #46/#50, 14 Oct 23:57Z] The in-app help answer to "Can I cancel an
 * order?", in the Terms' own rule: a cancel is free or refused, never a fee.
 *  - a store order: free until the store accepts it; after that, contact the store;
 *  - a ride, parcel or booking: free while unaccepted and for 1 minute after acceptance (owner 22 Oct 2026; was 5);
 *  - a service job: free until it is booked;
 *  - still free when no driver/rider is found or it runs very late; never once on its way;
 *  - paid by MMG and confirmed by the store: only the store cancels, and it refunds.
 * The older answer ("within the first few minutes … cancellation may not be available") described a
 * rule that no longer exists. cancelPolicyCopy.test.ts holds this text to the served Terms.
 */
export const CANCEL_ORDER_FAQ_ANSWER =
  'Yes, free, while the store hasn’t accepted your order. Once the store accepts it, it can’t be cancelled in the app: contact the store (the app shows the number it published). '
  + 'Rides, parcels and bookings can be cancelled free while nobody has accepted them, and for 1 minute after a driver, rider or provider accepts; after that, contact them. '
  + 'A service job can be cancelled free until it is booked. '
  + 'You can still cancel free if no driver or rider was found, or if it is running very late. Once it is on its way, it can’t be cancelled. '
  + 'If you paid by MMG and the store has confirmed your payment, ask the store to cancel: the store refunds you directly. '
  + 'Whenever an order you paid by MMG is cancelled, the store refunds you directly. '
  + 'Swift never charges a cancellation fee.';
