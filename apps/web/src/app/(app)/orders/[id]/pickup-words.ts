/** [O-2 · REVIEW-F S3-3 on #2055] What the customer is told at the counter. With the store's code off
 *  (the default) the store asks for the first name and order number.
 *  [PICKUP · owner 30 Oct 2026: "the code is still there rather than mark as picked up"] With the code off the
 *  customer gets no code at all: these words and the order number (the server sends this page no code then,
 *  pickupHandover=v1). An older server that does not say keeps today's code words. */
export function pickupCodeWords(pickupCodeRequired: boolean | undefined): string {
  return pickupCodeRequired === false
    ? 'At the counter, give your first name and order number.'
    : 'Show this pickup code';
}
