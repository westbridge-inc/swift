/**
 * [STORE-DASH · O-2, owner ruling 22 Oct 19:45Z] What the store reads at a hand-over: the takeaway
 * name and order-number check, the rider's first name, vehicle and photo, and the words — one plain
 * file (no React Native imports), read by the phone and imported as is by the web orders screens.
 * It imports nothing: the screen says whether the order is paused for an MMG payment review
 * (order-dispute mmgDisputePaused, which each orders screen already reads for its notice). That
 * keeps order-dispute inside the dashboard's shared step code, where the bundler inlines it, so
 * every dashboard page stays byte-for-byte the size it was (web perf budget on #2054).
 */

// ─── O-2 hand-overs (owner ruling 22 Oct 19:45Z; server contract STORE-FLOW, #2055) ───────────────
// - Takeaway: the store's requirePickupCode setting is OFF by default; the server says per order
//   (pickupCodeRequired). Off = "Handed to customer" in one tap, after checking the customer's first
//   name and the order number (PUT complete-pickup with no code). On = today's typed code.
// - Delivery with a Swift rider: "Handed to rider" (PUT handed-to-rider) writes one status-log row;
//   custody stays the rider's "Picked up". Shown only when the server knows the step (the order
//   carries handedToRiderAt), so an older server never gets a request it cannot answer.
// - These steps are added on top of the shared step list (shared.tsx / web vendor-hub orderActions)
//   by withHandoverSteps, on the order screens only: the dashboard's shared code does not grow
//   (REVIEW-F / web perf budget on #2054).

export type HandoverOrder = {
  status?: unknown; fulfillment?: unknown; fulfillmentMode?: unknown; riderId?: unknown; rider?: unknown;
  pickupCodeRequired?: unknown; handedToRiderAt?: unknown;
  customer?: { firstName?: unknown } | null; orderNumber?: unknown;
  paymentMethod?: unknown; orderType?: unknown; mmgClaimMismatchAt?: unknown;
} | null | undefined;

/** The takeaway hand-over needs no code: the store's setting is off. Unknown (an older server) = the code is still needed. */
export function handoverNeedsNoCode(order: HandoverOrder): boolean {
  return order?.pickupCodeRequired === false;
}

const RIDER_AT_STORE = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP', 'READY_FOR_PICKUP', 'READY'];

/** "Handed to rider" may be tapped: a Swift-rider delivery with its rider assigned, not marked yet, on a server that knows the step. */
export function canMarkHandedToRider(order: HandoverOrder): boolean {
  if (!order || !('handedToRiderAt' in order) || order.handedToRiderAt) return false;
  if (order.fulfillment !== 'DELIVERY' || order.fulfillmentMode === 'VENDOR_DELIVERY') return false;
  if (!order.riderId && !order.rider) return false;
  return RIDER_AT_STORE.includes(String(order.status ?? '').toUpperCase());
}

export type HandoverStep = 'handed-to-rider' | 'handed-to-customer';

/**
 * The order's steps with the O-2 hand-overs: with the pickup code off, "Mark picked up" becomes
 * "Handed to customer"; a Swift-rider delivery with nothing left for the kitchen gets "Handed to
 * rider". Nothing changes on an order paused for an MMG payment review (only Reject survives).
 */
export function withHandoverSteps<K extends string>(order: HandoverOrder, steps: { label: string; action: K }[], paused: boolean): { label: string; action: K | HandoverStep }[] {
  if (paused) return steps;
  if (handoverNeedsNoCode(order) && steps.some((s) => s.action === 'complete-pickup')) {
    return steps.map((s) => (s.action === 'complete-pickup' ? { label: HANDOVER_WORDS.toCustomer, action: 'handed-to-customer' as const } : s));
  }
  if (steps.length === 0 && canMarkHandedToRider(order)) return [{ label: HANDOVER_WORDS.toRider, action: 'handed-to-rider' }];
  return steps;
}

/**
 * [REVIEW-F S3-1 on #2054] The takeaway line when the store's pickup code is off: the name and
 * order-number check — but never a hand-over prompt on an order paused for an MMG payment review
 * (its notice says "Don't hand anything over until then"). Null when the code is on, or on an
 * older server: the screen keeps today's code words.
 */
export function pickupCheckWords(order: HandoverOrder, paused: boolean): string | null {
  if (!handoverNeedsNoCode(order)) return null;
  if (paused) return HANDOVER_WORDS.collects;
  return HANDOVER_WORDS.checkName(order?.customer?.firstName, order?.orderNumber);
}

type RiderLike = { user?: { firstName?: unknown } | null; vehicleType?: unknown; vehicleMake?: unknown; vehicleModel?: unknown; vehicleColor?: unknown; licensePlate?: unknown; photoUrl?: unknown } | null | undefined;
const word = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** An order number as words (the server may send a string or a number). */
const numberWord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : word(v));
/** A vehicle type as words ('MOTORCYCLE' -> 'Motorcycle'). */
const typeWord = (v: unknown) => {
  const w = word(v)?.replace(/_/g, ' ').toLowerCase();
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : null;
};

/** What the store checks at the hand-over: the rider's first name and vehicle (colour make model · plate). */
export function riderHandoverLine(rider: RiderLike): string | null {
  const name = word(rider?.user?.firstName);
  const vehicle = [word(rider?.vehicleColor), word(rider?.vehicleMake), word(rider?.vehicleModel)].filter(Boolean).join(' ') || typeWord(rider?.vehicleType);
  const plate = word(rider?.licensePlate);
  const parts = [name, [vehicle, plate].filter(Boolean).join(' · ') || null].filter(Boolean);
  return parts.length ? parts.join(' — ') : null;
}

/** The rider's photo, only as the server's resolved address (never a raw storage key). */
export function riderPhotoUrl(rider: RiderLike): string | null {
  const url = word(rider?.photoUrl);
  return url && /^https?:\/\//.test(url) ? url : null;
}

export const HANDOVER_WORDS = {
  toRider: 'Handed to rider',
  toCustomer: 'Handed to customer',
  // [REVIEW-F S4-2 on #2054] Only what the store can check: the name, the number, or both.
  checkName: (firstName: unknown, orderNumber: unknown) => {
    const name = word(firstName);
    const number = numberWord(orderNumber);
    if (name && number) return `Check the name before you hand it over: ${name} · order #${number}`;
    if (number) return `Check the order number before you hand it over: order #${number}`;
    if (name) return `Check the name before you hand it over: ${name}`;
    return 'Check who is collecting before you hand it over.';
  },
  collects: 'The customer collects this order.',
  checkRider: 'Check the rider before you hand it over:',
  handedToRider: 'Handed to the rider',
  settingTitle: 'Ask for the pickup code',
  settingOn: 'Customers collecting an order read out their code; you type it.',
  settingOff: 'You hand takeaway orders over after checking the customer’s first name and order number.',
} as const;
