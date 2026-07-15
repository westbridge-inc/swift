'use client';

// Vendor-dashboard auth: same localStorage-token pattern as the admin console
// (accepted V1 risk), plus the x-vendor-id store-switch header the vendor API
// uses everywhere.
const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';

const ACCESS_KEY = 'swift_web_token';
const REFRESH_KEY = 'swift_web_refresh';
const STORE_KEY = 'swift_web_store';

export function getToken() {
  return typeof window !== 'undefined' ? localStorage.getItem(ACCESS_KEY) : null;
}
export function setTokens(accessToken: string, refreshToken?: string | null) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}
export function clearSession() {
  if (typeof window === 'undefined') return;
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
async function tryRefresh(): Promise<string | null> {
  const refreshToken = typeof window !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null;
  if (!refreshToken) return null;
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data?.accessToken) return null;
  setTokens(json.data.accessToken, json.data.refreshToken);
  return json.data.accessToken as string;
}

export async function apiFetch(path: string, options?: RequestInit) {
  const doFetch = (token: string | null) => {
    const store = getSelectedStore();
    return fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        // Multipart bodies set their own boundary — only default JSON otherwise.
        ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(store && { 'x-vendor-id': store }),
        ...options?.headers,
      },
    });
  };

  let res = await doFetch(getToken());
  if (res.status === 401) {
    const fresh = await tryRefresh();
    if (fresh) res = await doFetch(fresh);
    if (res.status === 401) {
      clearSession();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      throw new Error('Session expired. Please sign in again.');
    }
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    throw new Error(json?.error?.message || `Request failed (${res.status})`);
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

/** OTP login gated to accounts that actually have a business. */
export async function verifyVendorLogin(phone: string, code: string) {
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
  if (!roles.includes('VENDOR')) {
    throw new Error('No business on this account yet — sign up as a business in the Swift app first.');
  }
  setTokens(data.tokens.accessToken, data.tokens.refreshToken);
  return data.user;
}
