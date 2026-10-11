import type { VendorGoLive } from '../verification/verification.service';
import { subscriptionOperability, type OperabilitySubscription } from '../subscription/operate-gate';
import { AppError } from '../../utils/errors';

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
//
// [MC-AD2] A weekly-fee hold is billing's to lift — by a payment the provider
// confirmed (BillingService.reinstateRows) or the nightly wrongful-suspension
// heal — never the console's. While the store's subscription cannot operate
// (the vendor gate's own rule, subscriptionOperability: unpaid and suspended,
// churned, past its grace, or billing stopped), a reinstate would clear the
// hold without a payment, push the owner a false "your store is back", and
// leave a store the subscription gates still refuse. That holds whatever the
// store's suspension source says: an admin suspension laid over an unpaid fee
// does not turn the debt into an admin matter.
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
  | 'OWNER_ACCOUNT_RESTRICTED'
  /** Suspended while its weekly fee is unpaid (or billing stopped): it comes back when billing confirms a payment, not from the console. */
  | 'FEE_UNPAID'
  /** A closed store is not reopened from the console. */
  | 'CLOSED';

export interface VendorActivationFacts {
  status: string;
  suspensionSource: string | null;
  ownerAccountStatus: string | null;
  /** The store's weekly-fee subscription (the operability fields); null when it has none yet. */
  subscription: OperabilitySubscription | null;
}

/** The subscription fields the operability rule reads — select these wherever the verdict is decided. */
export const OPERABILITY_SELECT = {
  status: true, gracePeriodEnd: true, autoRenew: true, currentPeriodEnd: true,
  billingConfirmationPausedAt: true, billingEnforcementDueAt: true, autoSuspendEnabled: true,
} as const;

/** May this store's subscription operate now? The vendor gate's rule and missing-row policy (vendor.routes.ts). */
export function feeOperable(subscription: OperabilitySubscription | null, now = new Date()): boolean {
  return subscriptionOperability(subscription, { missingRow: 'GRANDFATHER' }, now).operable;
}

export function vendorActivationNext(vendor: VendorActivationFacts, goLive: Pick<VendorGoLive, 'checklist' | 'disclosure'>): VendorActivationNext {
  if (vendor.status === 'ACTIVE') return 'LIVE';
  if (vendor.status === 'CLOSED') return 'CLOSED';
  if (vendor.suspensionSource === 'WIND_DOWN' || vendor.ownerAccountStatus === 'DEACTIVATED') return 'ACCOUNT_CLOSED';
  if (vendor.ownerAccountStatus === 'BANNED' || vendor.ownerAccountStatus === 'SUSPENDED') return 'OWNER_ACCOUNT_RESTRICTED';
  if (vendor.status === 'SUSPENDED' && !feeOperable(vendor.subscription)) return 'FEE_UNPAID';
  if (!goLive.checklist.complete) return 'NEEDS_DOCUMENTS';
  if (goLive.disclosure.engaged && goLive.disclosure.complete !== true) return 'NEEDS_DISCLOSURE';
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

/**
 * The refusal for a verdict the console may not act on, in plain words — or null when the verdict allows the
 * action (CAN_ACTIVATE / CAN_REINSTATE). One place, so the first read and the re-decision inside the reinstate
 * transaction refuse identically. LIVE is answered by the caller (400 ALREADY_ACTIVE) before any verdict.
 */
export function vendorActivationRefusal(
  next: VendorActivationNext,
  name: string,
  goLive: Pick<VendorGoLive, 'disclosure'>,
): AppError | null {
  switch (next) {
    case 'CLOSED':
      return new AppError(409, 'STORE_CLOSED', `${name} is closed. A closed store is not reopened from the console.`);
    case 'ACCOUNT_CLOSED':
      return new AppError(409, 'ACCOUNT_CLOSED', `${name}'s owner has closed their Swift account, so the store stays closed. It cannot be reopened from the console.`);
    case 'OWNER_ACCOUNT_RESTRICTED':
      return new AppError(409, 'OWNER_ACCOUNT_RESTRICTED', `${name} cannot be reinstated until its owner's banned or suspended account is reinstated first.`);
    case 'FEE_UNPAID':
      return new AppError(
        409,
        'FEE_UNPAID',
        `${name} cannot be reinstated while its weekly fee is unpaid or its weekly billing is stopped. The fee must be paid through the MMG checkout page first. Billing suspensions lift automatically after confirmed payment; admin suspensions still need Reinstate. The console cannot lift a fee hold.`,
      );
    case 'NEEDS_DOCUMENTS':
      return new AppError(
        409,
        'CHECKLIST_INCOMPLETE',
        `${name}'s required documents are not all approved and current — review them in the Verification queue first.`,
      );
    case 'NEEDS_DISCLOSURE':
      return new AppError(
        409,
        'DISCLOSURE_INCOMPLETE',
        `${name}'s documents are complete, but its storefront supplier information is not: missing ${disclosureMissingWords(goLive.disclosure.missing)}. It goes live by itself once that is complete.`,
        { missing: goLive.disclosure.missing },
      );
    case 'LIVE':
      return new AppError(400, 'ALREADY_ACTIVE', 'Vendor is already approved');
    case 'CAN_ACTIVATE':
    case 'CAN_REINSTATE':
      return null;
  }
}
