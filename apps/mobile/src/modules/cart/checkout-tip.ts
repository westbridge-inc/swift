/**
 * F-013-01: "The mobile tip chip starts an independent mutation, the order
 * payload omits the tip, and the Place Order button does not wait for that
 * mutation."
 *
 * Local intent therefore outranks the asynchronously persisted cart value.
 * Pickup and appointment-only baskets have no rider, so they never carry a tip.
 */
export function checkoutTipAmount(opts: {
  pickupOrApptOnly: boolean;
  selectedTip: number | null;
  cartTip: number | null | undefined;
}): number {
  return opts.pickupOrApptOnly ? 0 : opts.selectedTip ?? Number(opts.cartTip ?? 0);
}
