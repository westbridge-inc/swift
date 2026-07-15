import { invoke } from '@tauri-apps/api/core';

// Mission Control talks ONLY to the admin API (desktop standing order 26).
// Tokens live in the macOS Keychain via the Rust commands — never localStorage.
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

let accessToken: string | null = null;

export async function loadSession(): Promise<boolean> {
  accessToken = (await invoke<string | null>('keychain_get', { key: 'access' })) ?? null;
  return !!accessToken;
}

async function storeSession(access: string, refresh?: string | null) {
  accessToken = access;
  await invoke('keychain_set', { key: 'access', value: access });
  if (refresh) await invoke('keychain_set', { key: 'refresh', value: refresh });
}

export async function clearSession() {
  accessToken = null;
  await invoke('keychain_delete', { key: 'access' });
  await invoke('keychain_delete', { key: 'refresh' });
}

async function tryRefresh(): Promise<string | null> {
  const refreshToken = await invoke<string | null>('keychain_get', { key: 'refresh' });
  if (!refreshToken) return null;
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data?.accessToken) return null;
  await storeSession(json.data.accessToken, json.data.refreshToken);
  return json.data.accessToken as string;
}

export async function apiFetch(path: string, options?: RequestInit) {
  const doFetch = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options?.headers,
      },
    });

  let res = await doFetch(accessToken);
  if (res.status === 401) {
    const fresh = await tryRefresh();
    if (fresh) res = await doFetch(fresh);
    if (res.status === 401) {
      await clearSession();
      window.location.reload();
      throw new Error('Session expired.');
    }
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    // AppError taxonomy: surface code + requestId (desktop standing order 32).
    const code = json?.error?.code ? `[${json.error.code}] ` : '';
    throw new Error(`${code}${json?.error?.message || `Request failed (${res.status})`}`);
  }
  return json;
}

const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];

export async function sendOtp(phone: string) {
  const res = await fetch(`${API_URL}/api/v1/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'Could not send the code.');
}

/** OTP login gated to admin accounts — same realm the admin console uses. */
export async function verifyAdminLogin(phone: string, code: string) {
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
  if (!roles.some((r) => ADMIN_ROLES.includes(r))) {
    throw new Error('This account does not have admin access.');
  }
  await storeSession(data.tokens.accessToken, data.tokens.refreshToken);
  return data.user;
}

// ── Module data ──────────────────────────────────────────────────────────────
export const fetchOverview = () => apiFetch('/api/v1/admin/dashboard/overview').then((r) => r.data);
export const globalSearch = (q: string) =>
  apiFetch(`/api/v1/admin/search?q=${encodeURIComponent(q)}`).then((r) => r.data);
