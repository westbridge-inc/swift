/**
 * [GUARDRAILS §8 · owner #67] Swift never carries banned goods.
 *
 * The server screens a parcel's description against the catalogue's ban list and
 * refuses it in plain words (409 PROHIBITED_PARCEL). The sender also ticks
 * "This parcel has no prohibited items" before a parcel is sent, and the order
 * records the tick (`declaresNoProhibitedItems`, on the order's own trail). A
 * server without the field ignores it.
 */
export const PARCEL_DECLARATION = 'This parcel has no prohibited items';

/** What the tick refers to: the server's banned classes, in plain words. [Legal research A6/A10, in-app ¶22 · R1]
 *  adds weapons, fireworks, and letters, documents and mail (the Post Office's to carry in Guyana). */
export const PARCEL_BANNED_GOODS =
  'Swift never carries alcohol, tobacco, vapes, medicines, cannabis or other drugs, cooking gas (LPG), fuel, 18+ items, fireworks or explosives, pesticides or toxic chemicals, raw gold, diamonds or precious stones, firearms, ammunition or replicas, protected wildlife, counterfeit goods, currency and payment cards, or letters, documents and mail.';

/** Why the send button is waiting, in the sender's words; null when nothing is left for the sender to do. */
export function courierWaitingCaption(s: {
  estimateFailed: boolean;
  hasEstimate: boolean;
  recipientReady: boolean;
  declared: boolean;
}): string | null {
  if (s.estimateFailed && !s.hasEstimate) return 'Waiting on the price — retry the quote above.';
  if (!s.recipientReady) return "Add the recipient's name and phone to continue.";
  if (!s.declared) return 'Tick “This parcel has no prohibited items” to continue.';
  return null;
}
