/**
 * [MOB-038] AN OUTAGE IS NOT "YOU HAVE NO BUSINESS".
 *
 * The vendor profile query ran through a helper that turned EVERY failure into
 * `null`:
 *
 *     async function tryUnwrap(p) { try { return await unwrap(p); } catch { return null; } }
 *
 * and the screen read that null as absence: `if (!store) return <BusinessSetup />`.
 * So a 401, a 403, a 500, a dropped connection or a schema change told a
 * working restaurant that it had no business and offered to set one up — while
 * its orders were live and its customers were waiting.
 *
 * Worse, the same shape defaulted the member role: `owner?.myRole ?? 'OWNER'`.
 * An outage did not merely hide the business, it handed the person looking at
 * the screen OWNER capability over it.
 *
 * The rule is the one this codebase already applies to the mover and
 * service-provider profiles: **absence is a 404 and nothing else**. Every
 * other failure stays a failure, and an unknown role is unknown — never the
 * most privileged one.
 */

export type VendorMemberRole = 'OWNER' | 'MANAGER' | 'STAFF';

/** Why the profile could not be read. Each is a different thing to tell the
 *  person and a different thing to do about it. */
export type VendorProfileFailure = 'unauthorized' | 'forbidden' | 'unreachable' | 'malformed';

export type VendorProfileState = 'loading' | 'ready' | 'absent' | 'error';

/**
 * Absence is a 404. Anything else throws — the caller decides how to say so,
 * but it never gets to say "no business".
 *
 * ONE addition, for the account that has never been a vendor. The server
 * answers the self-profile read of a role the caller does not hold with 403
 * — deliberately, and pinned by its authz matrix ("authz answers, not
 * existence"), so that a wrong-role token never gets a route oracle. For a
 * customer who tapped "Swift Business" to list their first store, that 403
 * is the server confirming exactly what the app already knows: this account
 * holds no vendor role, so there is no business — the setup wizard is the
 * honest screen, not "this account cannot open that store". The caller
 * passes `outsider` from the account's OWN roles (lib/roleLanding
 * accountHoldsRole); a 403 for an account that DOES hold the role stays an
 * error, because then something is genuinely wrong.
 */
export async function unwrapOptionalVendorProfile<T>(
  request: Promise<any>,
  opts: { outsider?: boolean } = {},
): Promise<T | null> {
  try {
    const response = await request;
    return response?.data?.data as T;
  } catch (error: any) {
    const status = error?.response?.status;
    if (status === 404) return null;
    if (status === 403 && opts.outsider === true) return null;
    throw error;
  }
}

/** What went wrong, in terms the screen can act on. */
export function failureOf(error: unknown): VendorProfileFailure {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (typeof status === 'number') return 'unreachable';
  return 'unreachable';
}

/**
 * The role the SERVER named, or undefined.
 *
 * Undefined is a real answer: the screen shows no privileged tools rather than
 * assuming the most privileged role, which is what an outage used to grant.
 */
export function memberRoleOf(value: unknown): VendorMemberRole | undefined {
  return value === 'OWNER' || value === 'MANAGER' || value === 'STAFF' ? value : undefined;
}

export interface VendorProfileInput {
  readonly isLoading: boolean;
  readonly error: unknown;
  /** null only when the server answered 404 (or named zero stores). */
  readonly owner: { myRole?: unknown; vendors?: unknown[] } | null | undefined;
  readonly fetched: boolean;
}

export interface VendorProfileVerdict {
  readonly state: VendorProfileState;
  readonly failure?: VendorProfileFailure;
  readonly myRole: VendorMemberRole | undefined;
}

/**
 * One classification for the whole vendor shell.
 *
 * `absent` requires a completed read that found nothing — a verified 404 or a
 * well-formed owner with no stores. A payload that is not an object at all is
 * `malformed`, not absence: a schema change is an outage, not a closed
 * business.
 */
export function classifyVendorProfile(input: VendorProfileInput): VendorProfileVerdict {
  if (input.error) {
    return { state: 'error', failure: failureOf(input.error), myRole: undefined };
  }
  if (input.isLoading || !input.fetched) return { state: 'loading', myRole: undefined };
  if (input.owner === null || input.owner === undefined) return { state: 'absent', myRole: undefined };
  if (typeof input.owner !== 'object' || Array.isArray(input.owner)) {
    return { state: 'error', failure: 'malformed', myRole: undefined };
  }
  const stores = Array.isArray(input.owner.vendors) ? input.owner.vendors : [];
  if (stores.length === 0) return { state: 'absent', myRole: memberRoleOf(input.owner.myRole) };
  return { state: 'ready', myRole: memberRoleOf(input.owner.myRole) };
}

/**
 * [MOB-038] Is this store blocked on billing?
 *
 * The gate used to require `store.status === 'SUSPENDED'`, so a subscription
 * that was SUSPENDED or CHURNED without that flag being mirrored onto the
 * store row left the business in the live operations UI — taking orders it
 * could not be paid for.
 *
 * A blocked subscription blocks, whatever the store row says. The suspension
 * SOURCE still decides whether the reason shown is billing or moderation.
 */
export function billingBlocked(store: {
  status?: unknown;
  suspensionSource?: unknown;
  subscription?: { status?: unknown } | null;
} | null | undefined): boolean {
  if (!store) return false;
  const source = store.suspensionSource == null ? null : String(store.suspensionSource).toUpperCase();
  const subscription = String(store.subscription?.status ?? '').toUpperCase();
  const subscriptionBlocked = subscription === 'SUSPENDED' || subscription === 'CHURNED';
  // a store suspended BY billing is blocked; so is any store whose
  // subscription is blocked, mirrored to the store row or not
  if (source === 'BILLING') return true;
  return subscriptionBlocked;
}

/**
 * [NO-DEAD-ENDS · owner, 6 Oct] Which hold, if any, keeps this store from
 * working orders, so the screen names the real reason and the real door.
 *
 * The server writes three suspension sources (BILLING, ADMIN, WIND_DOWN) and
 * a CLOSED status. The root used to test for a 'MODERATION' source the server
 * never writes, so a store Swift suspended, or one whose owner's account was
 * closed, fell through to the onboarding checklist ("selling unlocks the
 * moment you're approved") with every document approved: no reason, no door.
 *
 *  - FEE_UNPAID: billing's hold (or a blocked subscription). Paying lifts it;
 *    accepted orders are still finished (owner ruling, 1 Oct).
 *  - Every other hold: payment does NOT lift it; only Swift support can.
 */
export type StoreHold = 'FEE_UNPAID' | 'SUSPENDED_BY_SWIFT' | 'OWNER_ACCOUNT_CLOSED' | 'SUSPENDED' | 'CLOSED';

export function storeHoldOf(store: {
  status?: unknown;
  suspensionSource?: unknown;
  subscription?: { status?: unknown } | null;
} | null | undefined): StoreHold | null {
  if (!store) return null;
  const status = String(store.status ?? '').toUpperCase();
  const source = store.suspensionSource == null ? null : String(store.suspensionSource).toUpperCase();
  if (status === 'CLOSED') return 'CLOSED';
  if (status === 'SUSPENDED') {
    if (source === 'BILLING') return 'FEE_UNPAID';
    if (source === 'ADMIN') return 'SUSPENDED_BY_SWIFT';
    if (source === 'WIND_DOWN') return 'OWNER_ACCOUNT_CLOSED';
    return 'SUSPENDED';
  }
  // A blocked subscription not (yet) mirrored onto an otherwise working store.
  return billingBlocked(store) ? 'FEE_UNPAID' : null;
}

/** The order states a store can still finish under a fee hold: accepted and
 *  not yet done (the server's IN_FLIGHT work). New orders wait to be declined. */
const TERMINAL_ORDER = new Set(['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'FAILED']);
const NEW_ORDER = new Set(['PENDING', 'PLACED']);
export function heldStoreOrders(orders: unknown): { accepted: any[]; waiting: any[] } {
  const list = Array.isArray(orders) ? orders : [];
  const open = list.filter((o: any) => o && typeof o.id === 'string' && !TERMINAL_ORDER.has(String(o.status ?? '').toUpperCase()));
  return {
    accepted: open.filter((o: any) => !NEW_ORDER.has(String(o.status ?? '').toUpperCase())),
    waiting: open.filter((o: any) => NEW_ORDER.has(String(o.status ?? '').toUpperCase())),
  };
}
