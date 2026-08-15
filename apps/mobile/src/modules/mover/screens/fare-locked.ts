// [REPORT-011 F-05] MMG money is LOCKED at the checkout total — the mover
// cannot undercut it. Hide the fare slider and NEVER submit a fare on MMG,
// so a recovered card can't consume the exclusive offer only to be rejected
// with MMG_PRICE_LOCKED (which burned that mover's offer).
export function fareLockedFor(
  job: { paymentMethod?: string | null } | null | undefined,
  offer: { paymentMethod?: string | null },
): boolean {
  return (job?.paymentMethod ?? offer.paymentMethod) === 'MOBILE_MONEY';
}

// [REPORT-010 F-07] Without a market anchor there is no
// legitimate price choice: send NO fare (= market rate).
// fare 0 used to clamp the mover's pay to the 60% floor on
// CASH and burn the offer on MMG.
export function fareToSubmit(fareLocked: boolean, marketMax: number, price: number): number | undefined {
  return !fareLocked && marketMax > 0 && price > 0 && price < marketMax ? price : undefined;
}
