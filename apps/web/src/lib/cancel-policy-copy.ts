/**
 * [Terms 2026-10-15 §7 · owner #46/#50, 14 Oct 23:57Z] What the public site says about cancelling, in the
 * Terms' own rule: a cancel is free or refused, never a fee. The FAQ used to say "after the store starts
 * work a cancellation may carry a cost, and the app tells you the exact amount" — a fee Swift no longer has.
 * cancel-policy-copy.test.ts holds these words to the served Terms (src/legal/generated.ts).
 */

/** The FAQ answer to "Can I cancel an order?". */
export const CANCEL_ORDER_ANSWER =
  'Yes, free, while the business has not accepted your order. Once it accepts, the order can no longer be cancelled in the app or here: '
  + 'contact the business (the order page shows the number it published). '
  + 'Rides, parcels and bookings can be cancelled free while nobody has accepted them, and for 5 minutes after a driver, rider or provider accepts; after that, contact them. '
  + 'A service job can be cancelled free until it is booked. '
  + 'You can still cancel free if no driver or rider was found, or if it is running very late. Once it is on its way, it can no longer be cancelled. '
  + 'If you paid by MMG and the business has confirmed your payment, ask the business to cancel: the business refunds you directly. '
  + 'Whenever an order you paid by MMG is cancelled, the business refunds you directly. '
  + 'Swift never charges a cancellation fee.';

/** [Review S3-1 on #1732] The /welcome card: the rule, not a window with a clock. */
export const CANCEL_FREE_SHORT = 'Cancel free until the store accepts your order. Swift never charges a cancellation fee.';

/** How it works, ordering step 2. */
export const CANCEL_EARLY_STEP =
  'Cancel free from the order screen while the store has not accepted your order. After that, contact the store: the order shows its number. '
  + 'If you paid by MMG and the store has confirmed your payment, ask the store to cancel: the store refunds you directly. Swift never charges a cancellation fee.';
