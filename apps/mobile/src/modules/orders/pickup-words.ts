/**
 * [O-2 · REVIEW-F S3-3 on #2055] What the customer is told at the counter for a takeaway. With the
 * store's code off (the default, `pickupCodeRequired: false`) the store asks for the first name and
 * order number; the code stays on screen in case an older store app asks for it. An older server
 * (no field) keeps today's words.
 */
export function pickupWords(pickupCodeRequired: boolean | null | undefined): { timeline: string; ready: string; waiting: string } {
  if (pickupCodeRequired === false) {
    return {
      timeline: 'Give your first name and order number at the counter.',
      ready: 'Give your first name and order number at the counter. If they ask for a code:',
      waiting: 'At the counter: your first name and order number (this code, if they ask)',
    };
  }
  return {
    timeline: 'Show the pickup code at the counter.',
    ready: 'Show this code at the counter',
    waiting: 'Pickup code — show at the counter',
  };
}
