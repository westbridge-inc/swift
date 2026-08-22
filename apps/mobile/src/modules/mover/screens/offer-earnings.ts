/**
 * What a mover is ACTUALLY paid for the job they are being offered.
 *
 * The offer card's big number is the FARE — the figure the slider governs and
 * the mover submits. It is not the same thing as what lands in their hand: the
 * API's own definition of a delivery's earnings is
 *
 *     totalEarning = deliveryFee + tipAmount
 *
 * (`rider.routes.ts`, four independent sites, and again as `settlementDue` in
 * `order.service.ts`). The customer's tip is fixed at checkout, before dispatch
 * ever runs, and `dispatch.service.ts` deliberately puts it on the offer
 * payload — but the card dropped it, so a mover decided whether to accept while
 * looking at a number smaller than their pay. They could decline work that was
 * worth taking, and the "100% yours" line sat beside a figure that was not, in
 * fact, all of it.
 *
 * `tipGoesToMover` is deliberately a required argument rather than something
 * inferred here. It is TRUE for deliveries, where the pay formula is proven in
 * code. It is FALSE for taxi, where driver earnings are accumulated in an
 * `Earning` table rather than computed from the order, so whether a ride tip
 * reaches the driver is UNVERIFIED — and an unverified promise about someone's
 * pay is worse than a quiet omission. See F-257.
 */
export interface OfferEarnings {
  /** The fare the slider governs — always shown. */
  fare: number;
  /** The customer's checkout tip. 0 whenever it is absent or not the mover's. */
  tip: number;
  /** What actually lands: fare + tip. */
  total: number;
  /** false ⇒ render the fare alone; there is no second number worth a line. */
  showTip: boolean;
}

/** Money that isn't a usable positive number is 0 — never NaN on a pay line. */
function amount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function offerEarnings(
  fare: unknown,
  tipAmount: unknown,
  tipGoesToMover: boolean,
): OfferEarnings {
  const f = amount(fare);
  const tip = tipGoesToMover ? amount(tipAmount) : 0;
  return { fare: f, tip, total: f + tip, showTip: tip > 0 };
}
