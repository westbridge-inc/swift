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

/** The notice kind that asks the owner for the number (routed to Account). */
export const NEEDS_PUBLIC_PHONE_KIND = 'vendor_needs_public_phone';

/** What this store still lacks to go live (documents aside). Empty = nothing. */
export function goLiveMissing(vendor: { publicPhone: string | null | undefined }): GoLiveMissing[] {
  return safePublicPhone(vendor.publicPhone) == null ? ['PUBLISHED_PHONE'] : [];
}

/** True while the store has never been live — the only stage the gate holds. */
export function awaitingFirstGoLive(vendor: { status: string }): boolean {
  return vendor.status === 'PENDING_APPROVAL';
}
