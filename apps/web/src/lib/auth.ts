'use client';

import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';

// ── The session ──────────────────────────────────────────────────────────────
// [W-01] THIS APP HOLDS NO CREDENTIAL. It used to keep both tokens in
// localStorage:
//
//     const ACCESS_KEY = 'swift_web_token';
//     const REFRESH_KEY = 'swift_web_refresh';
//
// Anything able to run one line of JavaScript on this origin could read them,
// and the refresh token is not a thirty-minute window — it is a renewable
// session belonging to a business that accepts orders and settles money, or to
// an earner whose pay link lives behind it.
//
// The session is now an HttpOnly cookie pair the API sets when this client
// names itself (`X-Swift-Client: web`) — the same rail the admin console uses
// (A-01). Nothing on the page can read or replay it, and login returns no
// tokens in the body at all: there is nothing to store.
//
// WHAT COOKIE MODE DOES NOT CHANGE, and is deliberately kept: the guards that
// stop one account's response rendering under another. Those were never about
// where the token lived — they are about a request outliving the session that
// issued it — so the principal is now tracked from the SERVER's attestation
// (`/auth/me`) instead of decoded out of a token the page can no longer see.
export const BROWSER_CLIENT = 'web';
const clientHeaders = { 'X-Swift-Client': BROWSER_CLIENT } as const;

const STORE_KEY = 'swift_web_store';
const CHECKOUT_ATTEMPT_PREFIX = 'swift_web_checkout_attempt';

/** Bumped by login, logout and any account change: a request from an older
 *  generation may never write to, or render under, the current session. */
let authGeneration = 0;
/** Who the SERVER says this browser is. Null until probed or signed in. */
let sessionPrincipal: string | null = null;

type AuthSnapshot = { principal: string | null; generation: number };

function clearStoredCheckoutAttempts(): void {
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key === CHECKOUT_ATTEMPT_PREFIX || key?.startsWith(`${CHECKOUT_ATTEMPT_PREFIX}:`)) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // Session storage may be disabled. There is no durable attempt to clear.
  }
}

function authSnapshot(): AuthSnapshot {
  return { principal: sessionPrincipal, generation: authGeneration };
}

/** Was this request issued by the same person whose answer is arriving?
 *
 *  A request taken before the app knew who it was (principal null — the very
 *  first paint, running alongside the session probe) is NOT a stale one: it
 *  carried the same cookies, so its answer belongs to whoever the probe went on
 *  to name. Refusing those was the whole cost of moving the principal from a
 *  token the page decoded to an attestation it has to ask for. Every real
 *  change of account — login, logout, expiry — bumps the generation, which is
 *  checked separately, so the tolerance cannot swallow one. A session that goes
 *  the other way (known -> null, the probe finding it gone) still fails here. */
function principalIsCompatible(snapshot: AuthSnapshot): boolean {
  return snapshot.principal === null || sessionPrincipal === snapshot.principal;
}

function snapshotIsCurrent(snapshot: AuthSnapshot): boolean {
  if (typeof window === 'undefined' || snapshot.generation !== authGeneration) return false;
  return principalIsCompatible(snapshot);
}

function responseContextIsCurrent(snapshot: AuthSnapshot, storeId: string | null): boolean {
  return snapshot.generation === authGeneration
    && principalIsCompatible(snapshot)
    && getSelectedStore() === storeId;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}

export function getSessionPrincipal(): string | null {
  return typeof window !== 'undefined' ? sessionPrincipal : null;
}

/**
 * [W-01] THE SERVER'S WORD on whether this browser has a session. Pages gate on
 * this, never on a stored token — there is no token to be present. It also
 * refreshes the locally tracked principal, which the mid-request account-change
 * guards below compare against.
 */
export async function sessionProbe(): Promise<{ ok: boolean; user?: Record<string, unknown> }> {
  if (typeof window === 'undefined') return { ok: false };
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/me`, { credentials: 'include', headers: { ...clientHeaders } });
    if (!res.ok) { sessionPrincipal = null; return { ok: false }; }
    const json = await res.json().catch(() => null);
    const user = json?.data?.user as { id?: unknown } | undefined;
    if (!user || typeof user.id !== 'string') { sessionPrincipal = null; return { ok: false }; }
    if (sessionPrincipal !== user.id) {
      // LEARNING the principal (null -> id) is not an account change: the
      // request that discovered it carried the very same cookies, so nothing
      // in flight can be another account's. Bumping the generation here would
      // fail every concurrent request with a spurious SESSION_CHANGED. Only a
      // switch between two KNOWN people is a change.
      if (sessionPrincipal !== null) {
        clearStoredCheckoutAttempts();
        authGeneration += 1;
      }
      sessionPrincipal = user.id;
    }
    return { ok: true, user: user as Record<string, unknown> };
  } catch {
    // A network failure is not "signed out" — say nothing rather than guess.
    return { ok: false };
  }
}

/** Adopt a session the server has just issued as cookies. No tokens involved. */
export function adoptSession(principal: string | null) {
  if (typeof window === 'undefined') return;
  if (!sessionPrincipal || !principal || sessionPrincipal !== principal) clearStoredCheckoutAttempts();
  authGeneration += 1;
  sessionPrincipal = principal;
}

/**
 * [W-01] SIGNING OUT IS A SERVER ACT NOW. With the credential in localStorage,
 * deleting it locally WAS the sign-out. An HttpOnly cookie cannot be deleted by
 * this script, so a local clear alone would leave the person signed in — the
 * next page load's probe would say yes and put them straight back. The server
 * revokes the session and expires both cookies; the local state is cleared
 * either way, so an unreachable server still lands on /login.
 */
export async function logout(): Promise<void> {
  try {
    // Through apiFetch on purpose: the access cookie lives fifteen minutes, so
    // a tab left open and then signed out would 401 here — and a logout that
    // 401s clears NOTHING, leaving the month-long refresh cookie alive to sign
    // the person straight back in. The refresh-and-retry makes the sign-out
    // land. `redirectOnExpired: false` because we are already leaving.
    await apiFetch('/api/v1/auth/logout', { method: 'POST', body: '{}' }, { redirectOnExpired: false });
  } catch {
    // Offline, or a session already gone: nothing here can reach the cookies,
    // and the local clear below still takes the person to /login.
  }
  clearSession();
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  authGeneration += 1;
  sessionPrincipal = null;
  clearStoredCheckoutAttempts();
  localStorage.removeItem(STORE_KEY);
}

export function getSelectedStore() {
  return typeof window !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
}
export function setSelectedStore(vendorId: string) {
  if (typeof window !== 'undefined') localStorage.setItem(STORE_KEY, vendorId);
}

let refreshFlight: Promise<boolean> | null = null;

/** One refresh at a time: concurrent 401s share the flight, so a rotated
 *  refresh cookie is never replayed and the family is never revoked by us. */
async function tryRefresh(): Promise<boolean> {
  if (!refreshFlight) {
    refreshFlight = (async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
          method: 'POST', credentials: 'include', headers: { ...clientHeaders },
        });
        return res.ok;
      } catch {
        return false;
      } finally {
        refreshFlight = null;
      }
    })();
  }
  return refreshFlight;
}

export async function apiFetch(
  path: string,
  options?: RequestInit,
  policy: { redirectOnExpired?: boolean } = {},
) {
  const requestSession = authSnapshot();
  const requestStore = getSelectedStore();
  const doFetch = () =>
    fetch(`${API_URL}${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        // Multipart bodies set their own boundary — only default JSON otherwise.
        ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...clientHeaders,
        ...(requestStore && { 'x-vendor-id': requestStore }),
        ...options?.headers,
      },
    });

  let res = await doFetch();
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed && snapshotIsCurrent(requestSession)) res = await doFetch();
    if (res.status === 401) {
      if (!snapshotIsCurrent(requestSession)) {
        throw new ApiRequestError('The signed-in account changed while this request was running. Try again.', 409, 'SESSION_CHANGED');
      }
      clearSession();
      if (policy.redirectOnExpired !== false && window.location.pathname !== '/login') {
        const returnPath = `${window.location.pathname}${window.location.search}`;
        window.location.href = `/login?next=${encodeURIComponent(returnPath)}`;
      }
      throw new ApiRequestError('Session expired. Please sign in again.', 401, 'SESSION_EXPIRED');
    }
  }
  if (!responseContextIsCurrent(requestSession, requestStore)) {
    throw new ApiRequestError('The signed-in account or selected store changed while this request was running. Try again.', 409, 'SESSION_CHANGED');
  }
  const json = await res.json().catch(() => ({}));
  if (!responseContextIsCurrent(requestSession, requestStore)) {
    throw new ApiRequestError('The signed-in account or selected store changed while this response was loading. Try again.', 409, 'SESSION_CHANGED');
  }
  if (!res.ok || json?.success === false) {
    throw new ApiRequestError(
      json?.error?.message || `Request failed (${res.status})`,
      res.status,
      typeof json?.error?.code === 'string' ? json.error.code : undefined,
    );
  }
  return json;
}

export async function sendOtp(phone: string) {
  const res = await fetch(`${API_URL}/api/v1/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ phone }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'Could not send the code.');
}

/** OTP login for partners: businesses land on /dashboard, earners on /portal. */
export async function verifyPartnerLogin(phone: string, code: string): Promise<{ user: unknown; home: string }> {
  const res = await fetch(`${API_URL}/api/v1/auth/verify-otp`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ phone, code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'That code is not valid.');
  const data = json.data;
  // [W-01] A browser client is answered with cookies and NO tokens, so the
  // signal that a session exists is the user the server names — not a
  // credential in the body, which is the thing this item removes.
  if (data.isNewUser || !data.user?.id) {
    throw new Error('No Swift account is registered to that number.');
  }
  const roles: string[] = data.user?.roles ?? [];
  // Same vendor-ness rule as the mobile app's authStore: role string or the
  // vendorOwner relation on the login payload.
  const isVendor = roles.includes('VENDOR') || roles.includes('VENDOR_OWNER') || !!data.user?.vendorOwner;
  const isMover = roles.some((r) => ['MOVER', 'RIDER', 'DRIVER'].includes(r));
  if (!isVendor && !isMover) {
    throw new Error('No business or earner profile on this account yet — sign up in the Swift app first.');
  }
  adoptSession(data.user.id);
  // An account with both keeps the store dashboard as home; /portal stays a link away.
  return { user: data.user, home: isVendor ? '/dashboard' : '/portal' };
}
