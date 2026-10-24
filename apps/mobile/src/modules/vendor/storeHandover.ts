/**
 * [STORE-DASH · O-2, owner ruling 22 Oct 19:45Z] What the store reads at a hand-over: the takeaway
 * name and order-number check, the rider's first name, vehicle and photo, and the words — one plain
 * file (no React Native imports), read by the phone and imported as is by the web orders screens.
 * The rules for WHEN a hand-over step is offered stay in storeOrderRules.ts.
 */
import { mmgDisputePaused } from './order-dispute';
import { handoverNeedsNoCode, type HandoverOrder } from './storeOrderRules';

/**
 * [REVIEW-F S3-1 on #2054] The takeaway line when the store's pickup code is off: the name and
 * order-number check — but never a hand-over prompt on an order paused for an MMG payment review
 * (its notice says "Don't hand anything over until then"). Null when the code is on, or on an
 * older server: the screen keeps today's code words.
 */
export function pickupCheckWords(order: HandoverOrder): string | null {
  if (!handoverNeedsNoCode(order)) return null;
  if (mmgDisputePaused(order)) return HANDOVER_WORDS.collects;
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
