// ---------------------------------------------------------------------------
// The cancellation policy — ONE implementation [SWIFT-UG-CRAFT-01].
//
// The service CHARGES by these numbers and the customer routes PREVIEW by
// them. They were previously two independent literals (order.service
// hardcoded 5/500 while customer.routes declared its own constants with a
// "must match" comment) — the exact drift class where a customer is shown one
// fee and "charged" another. Import from here or don't touch the policy.
//
// ADR: the fee is flat and announced-but-uncollected (cash-only platform —
// Swift can't collect it); its role is deterrence + the risk-score signal.
// Founder decision 2026-07-20: record it as a marker, keep displaying it.
// ---------------------------------------------------------------------------

/** Minutes after placing during which a PENDING order cancels free. Under
 *  LIFECYCLE_V2 the hold window itself is always free regardless. */
export const FREE_CANCEL_WINDOW_MIN = 5;

/** Flat late-cancellation fee (GYD, integer). */
export const LATE_CANCEL_FEE = 500;
