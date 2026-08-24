'use client';

// Vendor-dashboard auth: same localStorage-token pattern as the admin console
// (accepted V1 risk), plus the x-vendor-id store-switch header the vendor API
// uses everywhere.
const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';

const ACCESS_KEY = 'swift_web_token';
const REFRESH_KEY = 'swift_web_refresh';
const STORE_KEY = 'swift_web_store';
const CHECKOUT_ATTEMPT_PREFIX = 'swift_web_checkout_attempt';
let authGeneration = 0;

type AuthSnapshot = {
  accessToken: string | null;
  refreshToken: string | null;
  principal: string | null;
  generation: number;
};

const refreshFlights = new Map<string, Promise<string | null>>();

function principalFromToken(token: string | null): string | null {
  if (!token) return null;
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(window.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))) as { userId?: unknown };
    return typeof payload.userId === 'string' && payload.userId.length > 0 ? payload.userId : null;
  } catch {
    return null;
  }
}

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
  const accessToken = localStorage.getItem(ACCESS_KEY);
  return {
    accessToken,
    refreshToken: localStorage.getItem(REFRESH_KEY),
    principal: principalFromToken(accessToken),
    generation: authGeneration,
  };
}

function snapshotIsCurrent(snapshot: AuthSnapshot): boolean {
  if (typeof window === 'undefined' || snapshot.generation !== authGeneration) return false;
  const current = authSnapshot();
  return current.accessToken === snapshot.accessToken
    && current.refreshToken === snapshot.refreshToken
    && current.principal === snapshot.principal;
}

function responseContextIsCurrent(snapshot: AuthSnapshot, storeId: string | null): boolean {
  return snapshot.generation === authGeneration
    && getSessionPrincipal() === snapshot.principal
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

export function getToken() {
  return typeof window !== 'undefined' ? localStorage.getItem(ACCESS_KEY) : null;
}
export function getSessionPrincipal(): string | null {
  return typeof window !== 'undefined' ? principalFromToken(getToken()) : null;
}
export function setTokens(accessToken: string, refreshToken?: string | null) {
  if (typeof window === 'undefined') return;
  const previousPrincipal = getSessionPrincipal();
  const nextPrincipal = principalFromToken(accessToken);
  if (!previousPrincipal || !nextPrincipal || previousPrincipal !== nextPrincipal) clearStoredCheckoutAttempts();
  authGeneration += 1;
  localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  else if (previousPrincipal !== nextPrincipal) localStorage.removeItem(REFRESH_KEY);
}
export function clearSession() {
  if (typeof window === 'undefined') return;
  authGeneration += 1;
  clearStoredCheckoutAttempts();
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(STORE_KEY);
}

export function getSelectedStore() {
  return typeof window !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
}
export function setSelectedStore(vendorId: string) {
  if (typeof window !== 'undefined') localStorage.setItem(STORE_KEY, vendorId);
}

// Access tokens live 30m; transparently refresh on 401 (refresh lasts 7d) —
// a vendor working a lunch rush must never be logged out mid-queue.
async function tryRefresh(snapshot: AuthSnapshot): Promise<string | null> {
  if (!snapshot.accessToken || !snapshot.refreshToken || !snapshot.principal) return null;
  const flightKey = `${snapshot.generation}:${snapshot.principal}:${snapshot.refreshToken}`;
  const existing = refreshFlights.get(flightKey);
  if (existing) return existing;
  if (!snapshotIsCurrent(snapshot)) return null;

  const flight = (async () => {
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: snapshot.refreshToken }),
    });
    const json = await res.json().catch(() => null);
    const nextAccess = json?.data?.accessToken;
    const nextRefresh = json?.data?.refreshToken;
    if (!res.ok || typeof nextAccess !== 'string' || typeof nextRefresh !== 'string') return null;
    // Logout, login, account switching, and another-tab token writes all make
    // this stale result ineligible to overwrite the current browser session.
    if (!snapshotIsCurrent(snapshot)) return null;
    localStorage.setItem(ACCESS_KEY, nextAccess);
    localStorage.setItem(REFRESH_KEY, nextRefresh);
    return nextAccess;
  })();
  refreshFlights.set(flightKey, flight);
  try {
    return await flight;
  } finally {
    // Keep the settled flight briefly so a slower parallel 401 captured under
    // the same session can reuse the rotation instead of spuriously failing.
    window.setTimeout(() => {
      if (refreshFlights.get(flightKey) === flight) refreshFlights.delete(flightKey);
    }, 10_000);
  }
}

export async function apiFetch(
  path: string,
  options?: RequestInit,
  policy: { redirectOnExpired?: boolean } = {},
) {
  const requestSession = typeof window !== 'undefined' ? authSnapshot() : {
    accessToken: null,
    refreshToken: null,
    principal: null,
    generation: authGeneration,
  };
  const requestStore = getSelectedStore();
  const doFetch = (token: string | null) => {
    return fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        // Multipart bodies set their own boundary — only default JSON otherwise.
        ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(requestStore && { 'x-vendor-id': requestStore }),
        ...options?.headers,
      },
    });
  };

  let res = await doFetch(requestSession.accessToken);
  if (res.status === 401) {
    const fresh = await tryRefresh(requestSession);
    const refreshStillBound = fresh !== null
      && requestSession.generation === authGeneration
      && principalFromToken(fresh) === requestSession.principal
      && getToken() === fresh;
    if (refreshStillBound) res = await doFetch(fresh);
    if (res.status === 401) {
      const requestStillOwnsSession = snapshotIsCurrent(requestSession)
        || (refreshStillBound && getSessionPrincipal() === requestSession.principal);
      if (!requestStillOwnsSession) {
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'Could not send the code.');
}

/** OTP login for partners: businesses land on /dashboard, earners on /portal. */
export async function verifyPartnerLogin(phone: string, code: string): Promise<{ user: unknown; home: string }> {
  const res = await fetch(`${API_URL}/api/v1/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'That code is not valid.');
  const data = json.data;
  if (data.isNewUser || !data.tokens?.accessToken) {
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
  setTokens(data.tokens.accessToken, data.tokens.refreshToken);
  // An account with both keeps the store dashboard as home; /portal stays a link away.
  return { user: data.user, home: isVendor ? '/dashboard' : '/portal' };
}
