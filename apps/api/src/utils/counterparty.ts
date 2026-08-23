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
 *  driving, and whether they are trusted.
 *
 *  [F-028-11] LIVE COORDINATES ARE NOT IN HERE, deliberately.
 *
 *  Rider.currentLat/currentLng are the mover's PROFILE position: they keep
 *  updating every ~10s whenever that person is online, on any job, forever.
 *  They are not scoped to the order you are looking at. So including them in
 *  the default counterparty view meant every surface that shows a past order —
 *  a sender's order history, a vendor's order list with a status filter, and
 *  worst of all an unauthenticated `/courier/track/:token` link with no expiry
 *  — kept returning that mover's CURRENT position during unrelated later work.
 *
 *  A recipient who kept the tracking link from a parcel delivered months ago
 *  could watch the courier's day. That is a stalking surface, and unlike the
 *  storage keys elsewhere in this class, these are the live production values
 *  themselves — nothing needs to be signed or fetched to use them.
 *
 *  Live position is therefore opt-in per call site, and only legitimate while
 *  the handover is actually happening. See `liveLocationVisible`. */
export const RIDER_COUNTERPARTY_SELECT = {
  id: true,
  vehicleType: true,
  vehicleMake: true,
  vehicleModel: true,
  vehicleColor: true,
  licensePlate: true,
  vehiclePhotoUrl: true,
  profilePhotoUrl: true,
  averageRating: true,
  totalRatings: true,
  totalDeliveries: true,
} as const;

/** The live position fields, added ONLY when the order is still in flight. */
export const RIDER_LIVE_LOCATION_SELECT = {
  currentLat: true,
  currentLng: true,
  lastLocationUpdate: true,
} as const;

/** Statuses after which nobody may watch the mover any more. Deliberately a
 *  positive list of LIVE states rather than a list of terminal ones: a new
 *  status added to the enum defaults to NOT trackable. */
const TRACKABLE_STATUSES = new Set([
  'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
  'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
  'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED',
  'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'RIDE_IN_PROGRESS',
]);

/** May this order's watcher see where the mover is right now? */
export function liveLocationVisible(status: string | null | undefined): boolean {
  return !!status && TRACKABLE_STATUSES.has(status);
}

/** Strip the live position from an already-fetched party when the order it
 *  belongs to is no longer in flight. For call sites that must select the
 *  fields (a single query serving both live and historical rows). */
export function redactLiveLocation<T extends { status?: string | null; rider?: unknown; driver?: unknown }>(order: T): T {
  if (liveLocationVisible(order.status)) return order;
  for (const key of ['rider', 'driver'] as const) {
    const party = order[key] as Record<string, unknown> | null | undefined;
    if (party && typeof party === 'object') {
      party['currentLat'] = null;
      party['currentLng'] = null;
      party['lastLocationUpdate'] = null;
    }
  }
  return order;
}

/** The same, plus the contact details a live handover needs. Use the phone
 *  variant only where the parties are actually meeting. */
export const riderCounterpartySelect = (opts: { withPhone: boolean; withLiveLocation?: boolean; withAvatar?: boolean }) => ({
  ...RIDER_COUNTERPARTY_SELECT,
  // [F-028-11] Opt-in, and the caller must pair it with a status check —
  // selecting it is not permission to return it.
  ...(opts.withLiveLocation ? RIDER_LIVE_LOCATION_SELECT : {}),
  // [F-028-20] `avatar` is OPT-IN for the same reason. Under the production
  // private-storage contract it is a BARE OBJECT KEY, and the approved
  // resolver (resolveAvatarUrl) exists precisely so a key is never the
  // fallback — it returns a signed URL or null. Putting it in the shared
  // shape handed courier, vendor and dispatch surfaces a raw key they never
  // resolve. A caller that opts in is declaring it CALLS THE RESOLVER on the
  // way out; customer order surfaces do (resolveAvatarUrl[s] at both sites).
  user: {
    select: {
      firstName: true,
      lastName: true,
      ...(opts.withAvatar ? { avatar: true } : {}),
      ...(opts.withPhone ? { phone: true } : {}),
    },
  },
});
