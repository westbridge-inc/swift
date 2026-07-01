/**
 * The checkout endpoint splits a cart into one order per vendor and returns
 * `{ orders: [...] }`. Post-checkout navigation needs the first order's id.
 * Kept as a tiny pure helper so the response contract is unit-tested (a silent
 * shape change here would otherwise break order tracking with no compile error).
 */
export function pickOrderId(
  res: { orders?: { id: string }[]; order?: { id: string } } | null | undefined,
): string | undefined {
  return res?.orders?.[0]?.id ?? res?.order?.id;
}
