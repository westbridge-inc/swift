import { AppError } from './errors';
import { safeMmgPayUrl, validateMmgPayUrl, type MmgPayUrlValidation } from './mmg-pay-url';
import { safeMmgNumber } from './mmg-number';

// ---------------------------------------------------------------------------
// [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] A customer who pays a store by MMG
// pays it directly, to the store's MMG NUMBER, in MMG's own app. The store's
// MMG PAY LINK is replaced: it stays in the database, dormant, and comes back
// only when STORE_MMG_PAY_LINK is exactly '1' (unset everywhere = OFF).
//
// While OFF:
//  - no surface offers or shows a store's pay link (cart, checkout, storefront,
//    store card, the store's own profile);
//  - a store cannot set a new link (clearing one stays open);
//  - an app that still asks to pay by MMG the old way (builds 9-11, which know
//    only the link) is refused with an MMG_* code those builds already turn
//    into cash, and a plain sentence.
// An order already committed to a link keeps its own snapshot (legacy, dormant).
// ---------------------------------------------------------------------------

export const STORE_MMG_PAY_LINK_ENV = 'STORE_MMG_PAY_LINK';

export function storeMmgPayLinkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[STORE_MMG_PAY_LINK_ENV] === '1';
}

export type OfferedStoreLinkValidation = MmgPayUrlValidation | { valid: false; reason: 'PAY_LINKS_OFF' };

/** The ONE check every store-link OFFER uses (cart capability, checkout): off = not offered. */
export function validateOfferedStoreMmgPayUrl(rawUrl: string | null | undefined, env: Record<string, string | undefined> = process.env): OfferedStoreLinkValidation {
  if (!storeMmgPayLinkEnabled(env)) return { valid: false, reason: 'PAY_LINKS_OFF' };
  return validateMmgPayUrl(rawUrl);
}

/** The ONE read every store-link DISPLAY uses (storefront, store card, profile): null while off. */
export function offeredStoreMmgPayUrl(rawUrl: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  return storeMmgPayLinkEnabled(env) ? safeMmgPayUrl(rawUrl) : null;
}

export const STORE_MMG_PAY_LINK_OFF_CODE = 'MMG_PAY_LINK_OFF';
export const STORE_MMG_PAY_LINK_OFF_MESSAGE =
  "Swift now uses your store's MMG number instead of a pay link. Update Swift, then add your MMG number in Account.";

/** A NEW store link while the switch is off is refused; clearing one (empty) is always allowed. */
export function assertStoreMmgPayLinkWritable(rawUrl: string | null | undefined, env: Record<string, string | undefined> = process.env): void {
  if (storeMmgPayLinkEnabled(env)) return;
  if (!rawUrl?.trim()) return;
  throw new AppError(409, STORE_MMG_PAY_LINK_OFF_CODE, STORE_MMG_PAY_LINK_OFF_MESSAGE);
}

/** How a checkout says it pays the store's MMG NUMBER (build 12+, web). Absent = an app that knows only the link. */
export const MMG_PAY_TO_STORE_NUMBER = 'STORE_NUMBER' as const;

export const MMG_UPDATE_APP_CODE = 'MMG_UPDATE_APP';
export const MMG_UPDATE_APP_MESSAGE = 'Paying by MMG needs the latest Swift app. Update Swift to pay by MMG, or choose cash.';

/** Does this store take MMG to its number? (A stored row is re-checked on every read.) */
export function storeTakesMmgNumber(vendor: { mmgNumber: string | null | undefined }): boolean {
  return safeMmgNumber(vendor.mmgNumber) !== null;
}

/** [PAYMENT-SIMPLIFY · REVIEW-G S3-1 · COORD 18 Oct 2026] Closing a partner's account (deletion cutoff or
 *  wind-down) clears the store's MMG payee details — its number, a staged number, and the dormant pay link —
 *  the way a driver's link already is. Each order keeps its own committed number (orders.mmgNumberSnapshot):
 *  that order's payee, needed for disputes, kept under the order retention rule. */
export const VENDOR_MMG_DESTINATION_CLEARED = {
  mmgNumber: null, mmgNumberPending: null, mmgNumberPendingAt: null, mmgNumberApplyAt: null,
  mmgPayUrl: null, mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null,
} as const;
