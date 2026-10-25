/** [O-2 · REVIEW-F S3-3 on #2055] What the customer is told at the counter. With the store's code off
 *  (the default) the store asks for the first name and order number; the code stays on screen in case
 *  an older store app asks for it. */
export function pickupCodeWords(pickupCodeRequired: boolean | undefined): string {
  return pickupCodeRequired === false
    ? 'At the counter, give your first name and order number. If they ask for a code:'
    : 'Show this pickup code';
}
