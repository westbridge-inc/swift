import type { VendorGoLive } from '../verification/verification.service';

// ---------------------------------------------------------------------------
// [MC-PR2] WHAT THE CONSOLE MAY DO WITH A STORE, decided once.
//
// The admin "Approve" button used to be its own activation authority: it
// checked the document checklist and wrote ACTIVE, skipping what the single
// activation projection (VerificationService.projectVendorActivation) also
// requires — the storefront disclosure go-live gate (DOC-INV-27) and the
// activation expiry. It is now a request to run that projection, and the same
// verdict below decides both what the console offers (the activation
// checklist read) and what the approve route accepts, so the button can never
// offer what the route refuses.
//
// A suspended store is reinstated through the same route, under the same
// gates. A store whose owner closed their Swift account (the partner
// wind-down, or a closed account) is never reopened from the console: a
// deletion request is honoured end to end.
// ---------------------------------------------------------------------------

export type VendorActivationNext =
  /** Live already. */
  | 'LIVE'
  /** A required document is missing, waiting, rejected or out of date: decide it in the Review Center. */
  | 'NEEDS_DOCUMENTS'
  /** Documents complete, but the storefront supplier information is incomplete while the gate is engaged. */
  | 'NEEDS_DISCLOSURE'
  /** Waiting for approval with every go-live rule met: the projection can make it live now. */
  | 'CAN_ACTIVATE'
  /** Suspended with every go-live rule met: it can be reinstated. */
  | 'CAN_REINSTATE'
  /** The owner closed their Swift account; the store stays closed. */
  | 'ACCOUNT_CLOSED'
  /** A closed store is not reopened from the console. */
  | 'CLOSED';

export interface VendorActivationFacts {
  status: string;
  suspensionSource: string | null;
  ownerAccountStatus: string | null;
}

export function vendorActivationNext(vendor: VendorActivationFacts, goLive: Pick<VendorGoLive, 'checklist' | 'disclosure'>): VendorActivationNext {
  if (vendor.status === 'ACTIVE') return 'LIVE';
  if (vendor.status === 'CLOSED') return 'CLOSED';
  if (vendor.suspensionSource === 'WIND_DOWN' || vendor.ownerAccountStatus === 'DEACTIVATED') return 'ACCOUNT_CLOSED';
  if (!goLive.checklist.complete) return 'NEEDS_DOCUMENTS';
  if (goLive.disclosure.engaged && !goLive.disclosure.complete) return 'NEEDS_DISCLOSURE';
  return vendor.status === 'SUSPENDED' ? 'CAN_REINSTATE' : 'CAN_ACTIVATE';
}

/** The disclosure block's missing elements, in words (storefront-disclosure.ts names them). */
const DISCLOSURE_WORDS: Record<string, string> = {
  legalName: 'the legal or trading name',
  address: 'the business address',
  contact: "the owner's verified phone",
  operator: "Swift's own operator details (server configuration)",
  vendor: 'the store record',
};

export function disclosureMissingWords(missing: readonly string[]): string {
  const words = missing.map((m) => DISCLOSURE_WORDS[m] ?? m);
  return words.length ? words.join(', ') : 'an element';
}
