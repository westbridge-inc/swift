// ---------------------------------------------------------------------------
// [BOOK-S6b · owner C3 28 Oct 2026] The time a customer picked for a bookable
// listing, held between the store page's "Book" and the checkout's "Book now".
//
// The phone keeps this in memory for the session (stores/bookingStore.ts:
// "a slot is a moment in time — never persist a stale one"). The website keeps
// it for this tab only (sessionStorage), under the signed-in account, so it
// never outlives the visit or crosses to another account. It is never a
// promise: checkout sends it and the server judges it (taken, past, too soon).
// The `instant` flag only chooses words; the checkout answer decides them.
// ---------------------------------------------------------------------------
import { getSessionPrincipal } from './auth';

export type VisitMode = 'AT_BUSINESS' | 'MOBILE';

export interface HeldTime {
  itemId: string;
  /** ISO instant from the server's own slots answer. */
  slotStart: string;
  /** Where it happens: the business's setting, or the customer's choice when it offers both. */
  mode?: VisitMode;
  /** What the business offers, from the slots answer the time was picked from. */
  serviceMode?: 'AT_BUSINESS' | 'MOBILE' | 'BOTH';
  /** The slots answer said instantConfirmation === true (words only). */
  instant?: boolean;
}

const PREFIX = 'swift_web_held_time';

function storageKey(): string | null {
  const principal = getSessionPrincipal();
  return principal ? `${PREFIX}:${principal}` : null;
}

function valid(value: unknown): value is HeldTime {
  if (!value || typeof value !== 'object') return false;
  const v = value as { itemId?: unknown; slotStart?: unknown; mode?: unknown; serviceMode?: unknown; instant?: unknown };
  return typeof v.itemId === 'string' && v.itemId.length > 0
    && typeof v.slotStart === 'string' && Number.isFinite(Date.parse(v.slotStart))
    && (v.mode === undefined || v.mode === 'AT_BUSINESS' || v.mode === 'MOBILE')
    && (v.serviceMode === undefined || v.serviceMode === 'AT_BUSINESS' || v.serviceMode === 'MOBILE' || v.serviceMode === 'BOTH')
    && (v.instant === undefined || typeof v.instant === 'boolean');
}

/** The time picked for this listing in this tab, or null (none, another account, unreadable). */
export function readHeldTime(itemId: string): HeldTime | null {
  if (typeof window === 'undefined') return null;
  const key = storageKey();
  if (!key) return null;
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    return valid(parsed) && parsed.itemId === itemId ? parsed : null;
  } catch {
    return null;
  }
}

/** One booking per order: holding a time for one listing replaces any other. */
export function saveHeldTime(held: HeldTime): void {
  if (typeof window === 'undefined') return;
  const key = storageKey();
  if (!key || !valid(held)) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(held));
  } catch {
    // Storage can be disabled: checkout then asks for the time again.
  }
}

export function clearHeldTime(): void {
  if (typeof window === 'undefined') return;
  const key = storageKey();
  try {
    if (key) window.sessionStorage.removeItem(key);
  } catch {
    // Nothing durable to clear.
  }
}

/** Where the visit happens, as checkout sends it: the customer's choice when the
 *  business offers both, else the business's own setting (the server refuses a
 *  mode the business does not offer, MODE_NOT_OFFERED). Unknown: nothing is
 *  sent and the server applies the listing's own setting. */
export function visitModeFor(serviceMode: string | undefined, chosen: VisitMode): VisitMode | undefined {
  if (serviceMode === 'MOBILE') return 'MOBILE';
  if (serviceMode === 'BOTH') return chosen;
  if (serviceMode === 'AT_BUSINESS') return 'AT_BUSINESS';
  return undefined;
}

/** A visit to the customer's address: the one case a booking needs a delivery address. */
export function isHomeVisit(held: Pick<HeldTime, 'mode' | 'serviceMode'> | null | undefined): boolean {
  if (!held) return false;
  return held.mode === 'MOBILE' || (held.mode === undefined && (held.serviceMode === 'MOBILE' || held.serviceMode === 'BOTH'));
}
