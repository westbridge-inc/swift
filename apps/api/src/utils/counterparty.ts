/**
 * [F-027-07] What one party to an order may see about the other.
 *
 * Customer, vendor and courier-sender surfaces reached their mover with
 * `include: { rider: { include: { user: {...} } } }`. The nested `user` was
 * carefully selected; the Rider row itself was not — `include` means EVERY
 * column, and a Rider row carries:
 *
 *   nationalIdUrl, driverLicenseUrl, vehicleInsuranceUrl
 *       the mover's KYC documents. Handed to the person who ordered a parcel.
 *   safetySuspendedAt, safetyShadowRestrictedAt
 *       safety enforcement state. Disclosing a SHADOW restriction to a
 *       customer defeats the entire point of it being shadow.
 *   floatLimit, committedFloat
 *       the mover's cash position with Swift.
 *   acceptanceRate, completionRate, livenessLockedAt, lastLivenessPassAt,
 *   documentsVerifiedBy
 *       internal performance, identity-check state, and an admin's id.
 *
 * Under the S3/R2 provider the document values are bare private keys, so
 * today they are a storage-namespace disclosure rather than retrievable
 * files. That is the ONLY reason this is not already a document breach — and
 * it is why the obvious fix for the wider finding (sign object keys on the way
 * out) would have made this one WORSE, converting unusable keys into working
 * document links. Stop over-fetching first; sign second, and only what should
 * be visible.
 *
 * So: an explicit allow-list, and no `include` on a party row from a
 * counterparty-facing route. Adding a column to Rider must not silently add it
 * to a customer's response.
 */

/** Everything a counterparty legitimately needs: who is coming, what they are
 *  driving, where they are, and whether they are trusted. */
export const RIDER_COUNTERPARTY_SELECT = {
  id: true,
  vehicleType: true,
  vehicleMake: true,
  vehicleModel: true,
  vehicleColor: true,
  licensePlate: true,
  vehiclePhotoUrl: true,
  profilePhotoUrl: true,
  currentLat: true,
  currentLng: true,
  lastLocationUpdate: true,
  averageRating: true,
  totalRatings: true,
  totalDeliveries: true,
} as const;

/** The same, plus the contact details a live handover needs. Use the phone
 *  variant only where the parties are actually meeting. */
export const riderCounterpartySelect = (opts: { withPhone: boolean }) => ({
  ...RIDER_COUNTERPARTY_SELECT,
  user: { select: { firstName: true, lastName: true, avatar: true, ...(opts.withPhone ? { phone: true } : {}) } },
});
