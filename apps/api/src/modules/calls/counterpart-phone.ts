/**
 * [O-1 · owner 22 Oct 2026] Riders, drivers, movers, stores and customers never
 * see each other's PERSONAL phone number. A call between them goes through
 * Swift (the call bridge), so neither side needs the other's number.
 *
 * The store builds already installed (iPhone 9/11/12, Android vc7/vc8) dial
 * the number they are sent and know nothing of the bridge. They keep receiving
 * it until they are retired, so they never lose a way to reach the other side.
 * A client that knows the bridge says so with the header below and is sent no
 * counterpart phone at all.
 *
 * Retirement: when builds 9-12 / vc7-vc8 are gone, set
 * COUNTERPART_PHONES_TO_OLD_APPS=0 (launch checklist). From then on NO client
 * is sent a counterpart's personal number, whatever headers it sends.
 *
 * The header is CLIENT-CONTROLLED: a client that omits it is served like an
 * installed store build. Until the switch below is 0, any authenticated party
 * to a live order can therefore still read the counterpart's number by leaving
 * the header out. That is today's exposure, no wider (each route keeps its own
 * party + liveness checks), and is the accepted back-compat window. The header
 * only ever REMOVES numbers. There is no per-request build signal to tighten
 * with: installed phones send no build number, app-version.ts is advice only,
 * and the bridge reaches build 12 by OTA.
 *
 * Not covered here, deliberately: a person's OWN number (profile, own store
 * team), the number a business PUBLISHED for customers (publishedStorePhoneOf,
 * the receipt's seller line), and the admin/ops desk (masked + audited reveal).
 */

/** The wire marker a bridge-aware client (phone JS, website, dashboard) sends. */
export const CALL_BRIDGE_CLIENT_HEADER = 'x-swift-call-bridge';
export const CALL_BRIDGE_CLIENT_VERSION = '1';

/** The retirement switch. On unless set to '0' (blanks ignored; dark-features entry). */
export const COUNTERPART_PHONES_TO_OLD_APPS_ENV = 'COUNTERPART_PHONES_TO_OLD_APPS';

type Headers = Record<string, string | string[] | undefined>;

/**
 * May this request be sent another person's personal phone number?
 * Only an old store build (no bridge header) while the retirement switch is
 * on. Any value of the header counts as bridge-aware: a client that claims to
 * know the bridge is never sent a number.
 */
export function counterpartPhonesAllowed(
  request: { headers: Headers },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (request.headers[CALL_BRIDGE_CLIENT_HEADER] !== undefined) return false;
  return env[COUNTERPART_PHONES_TO_OLD_APPS_ENV]?.trim() !== '0';
}

/** The phone itself when this request may have it, else null (the key stays,
 *  so every build's `phone ? <Call> : null` simply shows no button). */
export function counterpartPhone(
  request: { headers: Headers },
  phone: string | null | undefined,
): string | null {
  return counterpartPhonesAllowed(request) ? phone ?? null : null;
}

/**
 * Null every counterpart personal phone on an order-shaped payload, in place:
 * customer.phone, rider.phone, rider.user.phone, driver.phone, driver.user.phone,
 * and the parcel recipient's number the sender typed (courierRecipientPhone,
 * shown to the assigned courier rider; the bridge can call the recipient).
 * A no-op when this request may have them.
 */
export function withCounterpartPhones<T>(request: { headers: Headers }, order: T): T {
  if (counterpartPhonesAllowed(request) || !order || typeof order !== 'object') return order;
  const row = order as Record<string, unknown>;
  for (const key of ['customer', 'rider', 'driver'] as const) {
    const party = row[key] as Record<string, unknown> | null | undefined;
    if (!party || typeof party !== 'object') continue;
    if ('phone' in party) party['phone'] = null;
    const user = party['user'] as Record<string, unknown> | null | undefined;
    if (user && typeof user === 'object' && 'phone' in user) user['phone'] = null;
  }
  if ('courierRecipientPhone' in row) row['courierRecipientPhone'] = null;
  return order;
}
