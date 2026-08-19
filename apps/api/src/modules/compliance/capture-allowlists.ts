/**
 * [DCR-1 NR5-01] Capture allowlists — minimisation at the point of entry.
 *
 * The declared set of PERSONAL-DATA fields each subject type may hand the
 * platform, distilled from the full ingress census (Codex nr5-allowlists
 * lane, 2026-08-19: every zod ingress × every personal field × a keep/trim/
 * drop ruling with file:line evidence). Adding a personal field to any
 * ingress REQUIRES a same-commit edit here — the census spec pins this
 * registry's shape, so the diff reviewer always sees both together.
 *
 * This file declares INTENT (which fields are allowed to exist at capture);
 * the zod schemas enforce shape per route. Fields ruled DROP by the census
 * either had their ingress removed or are registered product follow-ups
 * (see compliance log 2026-08-19).
 */

export const CAPTURE_ALLOWLISTS = {
  customer: [
    'phone', 'firstName', 'lastName', 'email', 'countryCode',
    'selfie', 'deviceId', 'deviceType', 'pushToken',
    'address.label', 'address.line1', 'address.line2', 'address.city',
    'address.region', 'address.lat', 'address.lng', 'address.instructions',
    'search.query', 'location.lat', 'location.lng',
    'cart.itemSpecialInstructions', 'checkout.deliveryInstructions',
    'courier.packageDescription', 'courier.packagePhoto',
    'consent.acceptTerms', 'consent.marketing',
    'emergencyContact.name', 'emergencyContact.phone',
  ],
  driver: [
    'phone', 'firstName', 'lastName', 'email',
    'selfie', 'liveLocation.lat', 'liveLocation.lng',
    'documents.identity', 'documents.licence', 'documents.insurance',
    'vehicle.plate', 'vehicle.model', 'mmgPayUrl',
  ],
  vendor_user: [
    'phone', 'firstName', 'lastName', 'email',
    'business.name', 'business.address', 'business.phone',
    'documents.ownerId', 'documents.registration', 'documents.operating',
    'mmgPayUrl', 'staff.invitePhone',
  ],
  advertiser: [
    'companyName', 'registrationNo', 'contactName', 'contactPhone',
    'contactEmail', 'campaign.name', 'campaign.destination',
  ],
  /** Data about SOMEONE ELSE the subject supplies — each needs its own
   *  notice + transaction-bound retention (census third-party rules). */
  third_party: [
    'courier.recipientName', 'courier.recipientPhone',
    'emergencyContact.name', 'emergencyContact.phone',
  ],
} as const;

export type CaptureSubject = keyof typeof CAPTURE_ALLOWLISTS;
