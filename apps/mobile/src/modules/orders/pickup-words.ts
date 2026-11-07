/**
 * [O-2 · REVIEW-F S3-3 on #2055] What the customer is told at the counter for a takeaway. With the
 * store's code off (the default, `pickupCodeRequired: false`) the store asks for the first name and
 * order number. An older server (no field) keeps today's words.
 * [PICKUP · owner 30 Oct 2026: "the code is still there rather than mark as picked up"] With the code off
 * the customer gets NO code: these words and the order number (the server sends this build no code then,
 * pickupHandover=v1); the store taps "Handed to customer".
 */
export function pickupWords(pickupCodeRequired: boolean | null | undefined): { timeline: string; ready: string; waiting: string } {
  if (pickupCodeRequired === false) {
    return {
      timeline: 'Give your first name and order number at the counter.',
      ready: 'Give your first name and order number at the counter.',
      waiting: 'At the counter: your first name and order number',
    };
  }
  return {
    timeline: 'Show the pickup code at the counter.',
    ready: 'Show this code at the counter',
    waiting: 'Pickup code — show at the counter',
  };
}

/** [PICKUP · owner 30 Oct 2026] The takeaway card shows the code only when the store asks for it (or an older
 *  server does not say) and there is one — never with the store's code off, even if a code arrives. */
export function pickupShowsCode(order: { pickupCode?: string | null; pickupCodeRequired?: boolean | null }): boolean {
  return order.pickupCodeRequired !== false && !!order.pickupCode;
}
