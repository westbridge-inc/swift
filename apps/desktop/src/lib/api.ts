import { invoke } from '@tauri-apps/api/core';

// Mission Control talks ONLY to the admin API (desktop standing order 26).
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Token store: the macOS Keychain in the native Tauri app (never localStorage
// in production). In a browser preview (`pnpm dev`) Tauri's invoke doesn't
// exist — calling it crashes with `window.__TAURI_INTERNALS__` undefined — so
// there we fall back to localStorage. The inTauri gate keeps the real app on
// the Keychain.
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// In the packaged app, refuse a plaintext API on a real host — a MITM on the
// admin's network would otherwise steal the admin token straight off the wire.
// localhost stays allowed for dev; the browser preview isn't the real client.
if (inTauri && API_URL.startsWith('http://') && !API_URL.includes('localhost') && !API_URL.includes('127.0.0.1')) {
  throw new Error('VITE_API_URL must use https:// in the packaged Mission Control app');
}

const KC = 'swift-mc:';
async function kcGet(key: string): Promise<string | null> {
  if (inTauri) { try { return (await invoke<string | null>('keychain_get', { key })) ?? null; } catch { return null; } }
  try { return localStorage.getItem(KC + key); } catch { return null; }
}
async function kcSet(key: string, value: string): Promise<void> {
  // [WR-051] Await the write — sign-in used to enter the authed state before
  // the keychain accepted the secret, so a denied prompt silently produced a
  // session that vanished on restart.
  if (inTauri) { await invoke('keychain_set', { key, value }).catch(() => {}); return; }
  try { localStorage.setItem(KC + key, value); } catch { /* ignore */ }
}
async function kcDelete(key: string): Promise<void> {
  if (inTauri) { await invoke('keychain_delete', { key }).catch(() => {}); return; }
  try { localStorage.removeItem(KC + key); } catch { /* ignore */ }
}

let accessToken: string | null = null;

export async function loadSession(): Promise<boolean> {
  // Tauri keychain restore fires an OS prompt on unsigned dev builds, so it's
  // opt-in there (VITE_RESTORE_SESSION). The browser preview has no such prompt
  // → restore from localStorage freely so a page refresh keeps you signed in.
  if (inTauri && !import.meta.env.VITE_RESTORE_SESSION) return false;
  accessToken = await kcGet('access');
  return !!accessToken;
}

async function storeSession(access: string, refresh?: string | null) {
  accessToken = access;
  await kcSet('access', access);
  if (refresh) await kcSet('refresh', refresh);
}

export async function clearSession() {
  accessToken = null;
  await kcDelete('access');
  await kcDelete('refresh');
}

/** [WR-018] Server-side revocation for sign-out. /auth/logout/refresh is
 *  purpose-built for a locally-cleared client: no access-token auth, the
 *  refresh credential names the session. Returns false when the server could
 *  not be told — the caller says so instead of pretending. */
export async function revokeSession(): Promise<boolean> {
  const refreshToken = await kcGet('refresh');
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/logout/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryRefresh(): Promise<string | null> {
  const refreshToken = await kcGet('refresh');
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

// ── Review Center ────────────────────────────────────────────────────────────
export const API_ORIGIN = API_URL;

export interface ReviewDoc {
  id: string;
  docType: string;
  role: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  reviewNote: string | null;
  user: { id: string; firstName: string | null; lastName: string | null; phone: string; countryCode: string } | null;
}

export const fetchReviewQueue = (status = 'PENDING', page = 1) =>
  apiFetch(`/api/v1/admin/verification/queue?status=${status}&page=${page}&limit=50`).then((r) => ({
    rows: r.data as ReviewDoc[],
    meta: r.meta as { total: number; totalPages: number },
  }));

export const approveDoc = (id: string, body: Record<string, unknown>) =>
  apiFetch(`/api/v1/admin/verification/${id}/approve`, { method: 'PUT', body: JSON.stringify(body) });

export const rejectDoc = (id: string, reason: string, reasonCode?: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/reject`, {
    method: 'PUT',
    body: JSON.stringify({ reason, ...(reasonCode ? { reasonCode } : {}) }),
  });

export const documentViewUrl = (id: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/document-url`).then((r) => {
    const url: string = r.data.url;
    const resolved = url.startsWith('http') ? url : `${API_URL}${url}`;
    // Defence-in-depth before it lands in an <iframe src>: only ever an http(s)
    // URL — never javascript:/data:/blob:, even if the server were tricked.
    const proto = new URL(resolved, API_URL).protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      throw new Error('Refusing a non-http document URL');
    }
    return resolved;
  });

/** Mirrors the server's RejectionReasonCode enum (verification.service). */
export const REASON_CODES = [
  'EXPIRED', 'UNREADABLE', 'WRONG_DOCUMENT', 'FACE_MISMATCH', 'NAME_MISMATCH',
  'INSURANCE_NOT_HIRE', 'NOT_YELLOW', 'SUSPECTED_TAMPERING', 'DUPLICATE', 'INCOMPLETE',
] as const;

// ── Live Ops ─────────────────────────────────────────────────────────────────
export const fetchOpsLive = () => apiFetch('/api/v1/admin/ops/live').then((r) => r.data);
export const retryDispatch = (orderId: string) =>
  apiFetch(`/api/v1/admin/orders/${orderId}/retry-dispatch`, { method: 'POST', body: '{}' });

// ── Agent ────────────────────────────────────────────────────────────────────
export const fetchAgentApprovals = () =>
  apiFetch('/api/v1/admin/agent/approvals?status=PENDING').then((r) => r.data);
export const decideAgentApproval = (id: string, approve: boolean) =>
  apiFetch(`/api/v1/admin/agent/approvals/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: '{}' });

export interface AgentAuditEvent {
  id: string;
  at: string;
  job: string;
  subjectId: string | null;
  action: string;
  /** suggested | executed | pending_approval | auto_executed | rejected | error */
  outcome: string;
  reasoning: string | null;
}
export const fetchAgentAudit = () =>
  apiFetch('/api/v1/admin/agent/audit?limit=50').then((r) => r.data as AgentAuditEvent[]);

// ── Support tickets ──────────────────────────────────────────────────────────
export interface SupportTicket {
  id: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  adminNote: string | null;
  orderId: string | null;
  createdAt: string;
  user: { firstName: string | null; lastName: string | null; phone: string } | null;
}
export const fetchSupport = (status = 'OPEN') =>
  apiFetch(`/api/v1/admin/support?status=${status}`).then((r) => ({
    tickets: r.data.tickets as SupportTicket[],
    total: r.data.total as number,
  }));
export const resolveTicket = (id: string, status: 'IN_PROGRESS' | 'RESOLVED', adminNote?: string) =>
  apiFetch(`/api/v1/admin/support/${id}/resolve`, {
    method: 'PUT',
    body: JSON.stringify({ status, ...(adminNote ? { adminNote } : {}) }),
  });

// ── SLA / stuck orders (FUL-008) ─────────────────────────────────────────────
export interface SlaBreach {
  orderId: string;
  orderNumber: string;
  status: string;
  openStage: 'ACCEPT' | 'PREP' | 'PICKUP_WAIT' | 'DELIVERY' | null;
  breached: boolean;
  worstOverMs: number;
}
export const fetchSlaBreaches = () =>
  apiFetch('/api/v1/admin/orders/sla-breaches').then((r) => ({
    rows: r.data as SlaBreach[],
    scanned: r.scanned as number,
    truncated: r.truncated as boolean,
  }));

// ── Moderation (UGC reports — STORE-001/002) ─────────────────────────────────
export interface ModerationReport {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  detail: string | null;
  status: string;
  createdAt: string;
  /** STORE-002: a snapshot of the reported content (or null if it's already gone). */
  target: Record<string, unknown> | null;
}
export const fetchModerationQueue = (status = 'PENDING') =>
  apiFetch(`/api/v1/admin/moderation/reports?status=${status}&limit=100`).then((r) => ({
    rows: r.data as ModerationReport[],
    pendingTotal: r.pendingTotal as number,
  }));
export const resolveReport = (id: string, status: 'ACTIONED' | 'DISMISSED' | 'REVIEWING', note?: string) =>
  apiFetch(`/api/v1/admin/moderation/reports/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ status, ...(note ? { note } : {}) }),
  });

// ── Compliance ───────────────────────────────────────────────────────────────
export const fetchCompliance = () => apiFetch('/api/v1/admin/compliance').then((r) => r.data);
export const runComplianceAudit = () =>
  apiFetch('/api/v1/admin/compliance/run', { method: 'POST', body: '{}' });
export const decideComplianceReview = (id: string, pass: boolean, note?: string) =>
  apiFetch(`/api/v1/admin/compliance/reviews/${id}/decide`, {
    method: 'POST',
    body: JSON.stringify({ pass, ...(note ? { note } : {}) }),
  });

// ── People ───────────────────────────────────────────────────────────────────
export const fetchUsers = (params: { search?: string; status?: string; page?: number } = {}) => {
  const q = new URLSearchParams({ page: String(params.page ?? 1), limit: '30' });
  if (params.search) q.set('search', params.search);
  if (params.status) q.set('status', params.status);
  return apiFetch(`/api/v1/admin/users?${q}`).then((r) => ({ rows: r.data as any[], meta: r.meta }));
};
export const suspendUser = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/users/${id}/suspend`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const unsuspendUser = (id: string) =>
  apiFetch(`/api/v1/admin/users/${id}/unsuspend`, { method: 'PUT', body: '{}' });

// ── Vendors & Billing ────────────────────────────────────────────────────────
export const fetchVendors = (params: { search?: string; status?: string; page?: number } = {}) => {
  const q = new URLSearchParams({ page: String(params.page ?? 1), limit: '30' });
  if (params.search) q.set('search', params.search);
  if (params.status) q.set('status', params.status);
  return apiFetch(`/api/v1/admin/vendors?${q}`).then((r) => ({ rows: r.data as any[], meta: r.meta }));
};
export const fetchPaymentMix = () => apiFetch('/api/v1/admin/finance/payment-mix').then((r) => r.data);

export interface RevenueSummary {
  thirtyDayMarkup: number;
  thirtyDayDeliveryFees: number;
  weeklySubscriptionRevenue: number;
  monthlySubscriptionRevenue: number;
  activeSubscriptions: number;
}
export const fetchRevenue = () =>
  apiFetch('/api/v1/admin/finance/revenue').then((r) => r.data as {
    dailyRevenue: Array<{ date: string; total: number; order_count: number }>;
    summary: RevenueSummary;
  });

// ── Health ───────────────────────────────────────────────────────────────────
export const fetchHealth = () =>
  fetch(`${API_ORIGIN}/health`).then(async (r) => ({ httpOk: r.ok, ...(await r.json()) }));
export const fetchDlq = () => apiFetch('/api/v1/admin/dlq').then((r) => r.data);
export const fetchAlertsHealth = () => apiFetch('/api/v1/admin/alerts/health').then((r) => r.data);
export const requeueDlqJob = (queue: string, id: string) =>
  apiFetch(`/api/v1/admin/dlq/${queue}/${id}/requeue`, { method: 'POST', body: '{}' });
export const discardDlqJob = (queue: string, id: string) =>
  apiFetch(`/api/v1/admin/dlq/${queue}/${id}`, { method: 'DELETE' });
