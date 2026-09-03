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
 */
export async function unwrapOptionalVendorProfile<T>(request: Promise<any>): Promise<T | null> {
  try {
    const response = await request;
    return response?.data?.data as T;
  } catch (error: any) {
    if (error?.response?.status === 404) return null;
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
