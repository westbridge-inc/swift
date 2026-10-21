// ---------------------------------------------------------------------------
// [UI-SWEEP U14 · COORD ruling 21 Oct] The website never shows a raw code.
// An order's `cancellationReason` is either words (a store's reject reason, a
// sender's or an admin's note, the server's own sentences) or a system code the
// server writes itself. A known code reads as the server's own words for that
// reader (its push copy: modules/dispatch/rescue.ts, dispatch.service.ts). An
// unknown code reads as nothing, and the caller shows its generic line.
// One copy for the store window and the customer's order page.
// ---------------------------------------------------------------------------

export type CancellationReader = 'customer' | 'store';

/** A system code: capitals, digits and underscores only ("NO_DRIVERS_AVAILABLE"). */
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]*$/;

const CODE_WORDS: Readonly<Record<string, Readonly<Record<CancellationReader, string>>>> = {
  // dispatch.service.ts: a ride request no driver took in time ("We couldn't find you a driver").
  NO_DRIVERS_AVAILABLE: {
    customer: 'No drivers came online in time, so your request was released. Nothing to pay.',
    store: 'No driver was found in time.',
  },
  // rescue.ts: ready food no rider could collect in time ("We couldn't find a rider in time").
  FOOD_TOO_OLD: {
    customer: 'Your order was ready but no rider could be found, so it was cancelled rather than delivered cold.',
    store: 'Too old to deliver: the order was ready but no rider could be found in time.',
  },
};

/** The reason in words for this reader, or null when there is nothing to say (no reason, or a code this build does not know). */
export function cancellationReasonWords(reason: unknown, reader: CancellationReader): string | null {
  if (typeof reason !== 'string') return null;
  const text = reason.trim();
  if (!text) return null;
  const known = Object.prototype.hasOwnProperty.call(CODE_WORDS, text) ? CODE_WORDS[text] : undefined;
  if (known) return known[reader];
  return SYSTEM_CODE.test(text) ? null : text;
}
