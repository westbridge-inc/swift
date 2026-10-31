/**
 * [PICKUP · owner 30 Oct 2026, staging test: "the code is still there rather than mark as picked up"] Whether the
 * CUSTOMER is given their order's takeaway code. With the store's code OFF (requirePickupCode false, the default
 * since O-2) the counter checks the customer's first name and order number and the store taps "Handed to customer":
 * the customer gets no code. With it ON, the customer shows the code, as before.
 *
 * `legacyScreen`: the order screen of a client that does not say it tells the customer the name + number instead
 * (no `pickupHandover=v1`: store build 12, whose own store screen still asks for the code). It keeps today's answer
 * until it updates — backward compatible with the build under store review. Every other customer surface (the
 * checkout answer, the order list, the delivery-to-pickup switch) is read by no client for the code: none carries it.
 *
 * The code is still minted for every takeaway: a store may turn its code on for a live order, and an older store
 * build may still send the code (verified as before). A leaf (no imports).
 */
export function customerPickupCode(
  pickupCode: string | null | undefined,
  storeAsksForCode: boolean | null | undefined,
  legacyScreen = false,
): string | null {
  if (!pickupCode) return null;
  return storeAsksForCode === true || legacyScreen ? pickupCode : null;
}

/** The customer order screen's capability: `pickupHandover=v1` = it shows the name + order-number words. */
export function saysPickupHandover(query: unknown): boolean {
  return (query as { pickupHandover?: unknown } | null | undefined)?.pickupHandover === 'v1';
}
