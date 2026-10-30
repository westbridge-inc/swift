// ---------------------------------------------------------------------------
// [owner #51, 14 Oct 2026] What a store still needs before it can go LIVE,
// beyond its documents (which the verification projection judges).
//
// A store needs a published contact phone: once a store accepts an order the
// customer can no longer cancel it in the app and is told to contact the store
// (owner #46), so there must always be a number to call. Only the number the
// store chose to PUBLISH counts, by the storefront's own validator — never the
// account line (`vendor.phone`).
//
// The gate holds a store's FIRST go-live only (status PENDING_APPROVAL). A
// store that has been live is never taken down for it — the owner ruled "no
// automatic unpublishing" for the stores already live without one.
// ---------------------------------------------------------------------------

import { safePublicPhone } from '../../utils/vendor-public-phone';

/** A go-live requirement the store has not met yet, as the apps name it. */
export type GoLiveMissing = 'PUBLISHED_PHONE';

/** The notice kind that asks the owner for the number (its tap opens the
 *  waiting store's own screen, where the number is entered). */
export const NEEDS_PUBLIC_PHONE_KIND = 'vendor_needs_public_phone';

/** What this store still lacks to go live (documents aside). Empty = nothing. */
export function goLiveMissing(vendor: { publicPhone: string | null | undefined }): GoLiveMissing[] {
  return safePublicPhone(vendor.publicPhone) == null ? ['PUBLISHED_PHONE'] : [];
}

/** True while the store has never been live — the only stage the gate holds. */
export function awaitingFirstGoLive(vendor: { status: string }): boolean {
  return vendor.status === 'PENDING_APPROVAL';
}

// ---------------------------------------------------------------------------
// [CHAINS PR2 · REVIEW-F #2220 S3-1] WHO a never-live store is waiting for.
//
// A store waiting to go live is told "waiting for Swift's approval" ONLY when nothing is owed by its owner. The
// owner's part of the go-live checklist is: the documents its type needs (each one sent; one Swift is still reading
// is Swift's part), the published number customers can call (above), and, for a registered restaurant, the food
// handlers tick (food-handlers.ts). Anything missing there is named as the owner's next step. When the owner's part
// is complete, the rest is Swift's: reading a document, or (for a branch) a person approving it.
// ---------------------------------------------------------------------------

/** An owner's step before a store can go live, as the apps name it (each opens where it is done). */
export type GoLiveStep = 'DOCUMENTS' | 'PUBLISHED_PHONE' | 'FOOD_HANDLERS';

/** A never-live store's go-live: whose turn it is, and the owner's steps still to do (empty when it is Swift's). */
export interface StoreGoLive { waitingFor: 'OWNER' | 'SWIFT'; steps: GoLiveStep[] }

/** A checklist document the OWNER must act on: never sent, sent back, or out of date. A document Swift is still
 *  reading (PENDING) is Swift's turn, and an approved one is done. */
const OWNER_DOCUMENT_STATES: ReadonlySet<string> = new Set(['MISSING', 'REJECTED', 'EXPIRED']);

export function storeGoLive(
  store: { status: string; publicPhone: string | null | undefined },
  facts: { documentStates: readonly string[]; foodHandlers: { required: boolean; attested: boolean } },
): StoreGoLive {
  const steps: GoLiveStep[] = [];
  if (facts.documentStates.some((state) => OWNER_DOCUMENT_STATES.has(state))) steps.push('DOCUMENTS');
  if (awaitingFirstGoLive(store) && goLiveMissing(store).length > 0) steps.push('PUBLISHED_PHONE');
  if (facts.foodHandlers.required && !facts.foodHandlers.attested) steps.push('FOOD_HANDLERS');
  return { waitingFor: steps.length > 0 ? 'OWNER' : 'SWIFT', steps };
}
