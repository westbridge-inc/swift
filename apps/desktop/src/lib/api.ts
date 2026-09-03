import { invoke } from '@tauri-apps/api/core';

// Mission Control talks ONLY to the admin API (desktop standing order 26).
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

// Token store: the macOS Keychain in the native Tauri app (never localStorage
// in production). In a browser preview (`pnpm dev`) Tauri's invoke doesn't
// exist — calling it crashes with `window.__TAURI_INTERNALS__` undefined — so
// there we fall back to localStorage. The inTauri gate keeps the real app on
// the Keychain.
const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function setNativeOperatorMenuEnabled(enabled: boolean): Promise<void> {
  if (!inTauri) return;
  await invoke('set_operator_menu_enabled', { enabled });
}

// In the packaged app, refuse a plaintext API on a real host — a MITM on the
// admin's network would otherwise steal the admin token straight off the wire.
// localhost stays allowed for dev; the browser preview isn't the real client.
if (inTauri) {
  const api = new URL(API_URL);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(api.hostname);
  const safeTransport = api.protocol === 'https:' || (api.protocol === 'http:' && loopback);
  if (!safeTransport) {
    throw new Error('VITE_API_URL must use https:// in the packaged Mission Control app');
  }
}

const KC = 'swift-mc:';
async function kcGet(key: string): Promise<string | null> {
  if (inTauri) {
    try {
      return (await invoke<string | null>('keychain_get', { key })) ?? null;
    } catch {
      throw new Error('Mission Control could not read the secure session from macOS Keychain.');
    }
  }
  try {
    return localStorage.getItem(KC + key);
  } catch {
    throw new Error('Mission Control could not read the browser preview session.');
  }
}
async function kcSet(key: string, value: string): Promise<void> {
  // [WR-051] Await the write — sign-in used to enter the authed state before
  // the keychain accepted the secret, so a denied prompt silently produced a
  // session that vanished on restart.
  if (inTauri) {
    try {
      await invoke('keychain_set', { key, value });
      return;
    } catch {
      throw new Error('Mission Control could not store the secure session in macOS Keychain.');
    }
  }
  try {
    localStorage.setItem(KC + key, value);
  } catch {
    throw new Error('Mission Control could not store the browser preview session.');
  }
}
async function kcDelete(key: string): Promise<void> {
  if (inTauri) {
    try {
      await invoke('keychain_delete', { key });
      return;
    } catch {
      throw new Error('Mission Control could not remove the secure session from macOS Keychain.');
    }
  }
  try {
    localStorage.removeItem(KC + key);
  } catch {
    throw new Error('Mission Control could not remove the browser preview session.');
  }
}

let accessToken: string | null = null;
let sessionGeneration = 0;
let sessionTransitionInFlight = false;
let sessionMutationQueue: Promise<void> = Promise.resolve();

function withSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = sessionMutationQueue.then(operation, operation);
  sessionMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function loadSession(): Promise<boolean> {
  // Tauri keychain restore fires an OS prompt on unsigned dev builds, so it's
  // opt-in there (VITE_RESTORE_SESSION). The browser preview has no such prompt
  // → restore from localStorage freely so a page refresh keeps you signed in.
  if (inTauri && !import.meta.env.VITE_RESTORE_SESSION) return false;
  accessToken = await kcGet('access');
  return !!accessToken;
}

async function storeSession(
  access: string,
  refresh?: string | null,
  expectedGeneration = sessionGeneration,
): Promise<boolean> {
  return withSessionMutation(async () => {
    if (expectedGeneration !== sessionGeneration) return false;
    try {
      // Write refresh first and access last. A restored session is considered
      // present only when the access credential exists, so a partial first
      // write can never masquerade as a complete login.
      if (refresh) await kcSet('refresh', refresh);
      await kcSet('access', access);
    } catch (error) {
      accessToken = null;
      const cleanup = await Promise.allSettled([
        kcDelete('access'),
        refresh ? kcDelete('refresh') : Promise.resolve(),
      ]);
      if (cleanup.some((result) => result.status === 'rejected')) {
        throw new Error('Secure session storage failed, and Keychain cleanup could not be confirmed.');
      }
      throw error;
    }
    if (expectedGeneration !== sessionGeneration) return false;
    accessToken = access;
    sessionTransitionInFlight = false;
    return true;
  });
}

export async function clearSession() {
  sessionTransitionInFlight = true;
  sessionGeneration += 1;
  const clearGeneration = sessionGeneration;
  accessToken = null;
  await withSessionMutation(async () => {
    const removals = await Promise.allSettled([kcDelete('access'), kcDelete('refresh')]);
    if (removals.some((result) => result.status === 'rejected')) {
      throw new Error('Mission Control could not confirm that every local Keychain credential was removed.');
    }
    if (sessionGeneration === clearGeneration) sessionTransitionInFlight = false;
  });
}

/** [WR-018] Server-side revocation for sign-out. /auth/logout/refresh is
 *  purpose-built for a locally-cleared client: no access-token auth, the
 *  refresh credential names the session. Returns false when the server could
 *  not be told — the caller says so instead of pretending. */
export async function revokeSession(): Promise<boolean> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const attempt = (async () => {
    const refreshToken = await kcGet('refresh');
    if (!refreshToken) return false;
    const res = await fetch(`${API_URL}/api/v1/auth/logout/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
    return res.ok;
  })().catch(() => false);
  const timedOut = new Promise<boolean>((resolve) => {
    deadline = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, 5_000);
  });

  try {
    return await Promise.race([attempt, timedOut]);
  } finally {
    if (deadline) clearTimeout(deadline);
    controller.abort();
  }
}

async function tryRefresh(expectedGeneration: number): Promise<string | null> {
  if (sessionTransitionInFlight || expectedGeneration !== sessionGeneration) return null;
  const refreshToken = await kcGet('refresh');
  if (sessionTransitionInFlight || expectedGeneration !== sessionGeneration) return null;
  if (!refreshToken) return null;
  const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.data?.accessToken) return null;
  const stored = await storeSession(json.data.accessToken, json.data.refreshToken, expectedGeneration);
  return stored ? json.data.accessToken as string : null;
}

let refreshInFlight: { generation: number; promise: Promise<string | null> } | null = null;

function refreshAccessToken(generation: number): Promise<string | null> {
  if (!refreshInFlight || refreshInFlight.generation !== generation) {
    const promise = tryRefresh(generation).finally(() => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    });
    refreshInFlight = { generation, promise };
  }
  return refreshInFlight.promise;
}

type ApiFetchOptions = Parameters<typeof fetch>[1];

export async function apiFetch(path: string, options?: ApiFetchOptions) {
  if (sessionTransitionInFlight) {
    throw new Error('The secure session is changing. This request was not sent.');
  }
  const requestGeneration = sessionGeneration;
  const doFetch = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options?.headers,
      },
    });

  const tokenUsed = accessToken;
  let attemptedToken = tokenUsed;
  let res = await doFetch(tokenUsed);
  if (res.status === 401) {
    if (sessionGeneration !== requestGeneration || sessionTransitionInFlight) {
      throw new Error('The session changed while this request was in flight. It was not replayed.');
    }
    // The briefing opens several feeds together. If another one already
    // rotated the token while this request was in flight, retry that token;
    // otherwise share exactly one refresh request across every 401.
    if (accessToken && accessToken !== tokenUsed) {
      attemptedToken = accessToken;
      res = await doFetch(accessToken);
    }
    if (res.status === 401) {
      if (sessionGeneration !== requestGeneration || sessionTransitionInFlight) {
        throw new Error('The session changed while this request was in flight. It was not replayed.');
      }
      const fresh = await refreshAccessToken(requestGeneration);
      if (sessionGeneration !== requestGeneration || sessionTransitionInFlight) {
        throw new Error('The session changed while this request was in flight. It was not replayed.');
      }
      if (fresh) {
        attemptedToken = fresh;
        res = await doFetch(fresh);
      }
    }
    if (res.status === 401) {
      if (sessionGeneration === requestGeneration && accessToken === attemptedToken) {
        await clearSession();
        window.location.reload();
        throw new Error('Session expired.');
      }
      throw new Error('The session changed while this request was in flight.');
    }
  }
  if (sessionGeneration !== requestGeneration || sessionTransitionInFlight) {
    throw new Error('The session changed while this request was in flight. Its response was discarded.');
  }
  const json = await res.json().catch(() => ({}));
  if (sessionGeneration !== requestGeneration || sessionTransitionInFlight) {
    throw new Error('The session changed while this response was being read. Its data was discarded.');
  }
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
  const stored = await storeSession(data.tokens.accessToken, data.tokens.refreshToken);
  if (!stored) throw new Error('The session changed before sign-in completed.');
  return data.user;
}

// ── Module data ──────────────────────────────────────────────────────────────
function requireApiArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) throw new Error(`The admin API did not report ${field}.`);
  return value as T[];
}

function requireApiNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`The admin API did not report ${field}.`);
  }
  return value;
}

export interface DashboardOverview {
  totalUsers: number;
  todayNewUsers: number;
  totalOrders: number;
  todayOrders: number;
  todayCompletedOrders: number;
  activeRiders: number;
  activeDrivers: number;
  activeVendors: number;
  totalVendors: number;
  revenue: {
    weeklySubscriptionRevenue: number;
    todayDeliveryFees: number;
    todayTotal: number;
  };
  subscriptionBreakdown: Array<{ type: string; count: number; weeklyRevenue: number }>;
  alerts: { pendingVendors: number; pastDueSubs: number; unassignedOrders: number };
}

export const fetchOverview = () =>
  apiFetch('/api/v1/admin/dashboard/overview').then((r) => {
    const data = r.data as DashboardOverview | undefined;
    if (!data || !data.alerts) throw new Error('The admin API did not report dashboard overview data.');
    requireApiNumber(data.activeRiders, 'active riders');
    requireApiNumber(data.activeDrivers, 'active drivers');
    return data;
  });
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

export interface ReviewApplicantRecord {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  rider: {
    vehicleType: string;
    vehicleMake: string | null;
    vehicleModel: string | null;
    vehicleColor: string | null;
    licensePlate: string | null;
  } | null;
  driver: {
    vehicleType: string;
    vehicleMake: string;
    vehicleModel: string;
    vehicleColor: string;
    licensePlate: string;
  } | null;
  vendorOwner: {
    vendors: Array<{
      id: string;
      name: string;
      vendorType: string;
      status: string;
      city: string | null;
    }>;
  } | null;
}

export const fetchReviewQueue = (status = 'PENDING', page = 1) =>
  apiFetch(`/api/v1/admin/verification/queue?status=${status}&page=${page}&limit=50`).then((r) => ({
    rows: requireApiArray<ReviewDoc>(r.data, 'the document queue'),
    meta: {
      total: requireApiNumber(r.meta?.total, 'document queue depth'),
      totalPages: requireApiNumber(r.meta?.totalPages, 'document queue pages'),
    },
  }));

export const fetchReviewApplicant = (id: string) =>
  apiFetch(`/api/v1/admin/users/${encodeURIComponent(id)}`).then((r) => {
    const data = r.data as ReviewApplicantRecord | undefined;
    if (!data?.id) throw new Error('The admin API did not report the applicant record.');
    return data;
  });

export const approveDoc = (id: string, body: Record<string, unknown>) =>
  apiFetch(`/api/v1/admin/verification/${id}/approve`, { method: 'PUT', body: JSON.stringify(body) });

export const rejectDoc = (id: string, reason: string, reasonCode?: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/reject`, {
    method: 'PUT',
    body: JSON.stringify({ reason, ...(reasonCode ? { reasonCode } : {}) }),
  });

export const documentViewUrl = (id: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/document-url`).then((r) => {
    const url: unknown = r.data?.url;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('The admin API did not return a document preview URL.');
    }
    const resolved = url.startsWith('http') ? url : `${API_URL}${url}`;
    // Defence-in-depth before it lands in an <iframe src>: only ever an http(s)
    // URL — never javascript:/data:/blob:, even if the server were tricked.
    const parsed = new URL(resolved, API_URL);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Refusing a non-http document URL');
    }
    if (parsed.origin !== new URL(API_URL).origin) {
      throw new Error('Preview unavailable: the API returned an external storage URL that the locked desktop policy cannot frame.');
    }
    if (parsed.pathname.startsWith('/uploads/verification/')) {
      throw new Error('Preview unavailable: this document needs an API-origin render route.');
    }
    return resolved;
  });

/** Mirrors the server's RejectionReasonCode enum (verification.service). */
export const REASON_CODES = [
  'EXPIRED', 'UNREADABLE', 'WRONG_DOCUMENT', 'FACE_MISMATCH', 'NAME_MISMATCH',
  'INSURANCE_NOT_HIRE', 'NOT_YELLOW', 'SUSPECTED_TAMPERING', 'DUPLICATE', 'INCOMPLETE',
] as const;

// ── Live Ops ─────────────────────────────────────────────────────────────────
export interface OpsLiveSnapshot {
  movers: Array<{ id: string; kind: 'rider' | 'driver'; busy: boolean }>;
  activeOrders: Array<{ id: string; orderNumber: string; status: string; orderType: string }>;
  exhaustedSearches: Array<{
    id: string;
    orderId: string;
    orderNumber: string | null;
    vertical: string;
    candidatesTried: number;
    exhaustedAt: string | null;
  }>;
}

export const fetchOpsLive = () =>
  apiFetch('/api/v1/admin/ops/live').then((r) => {
    const data = r.data as OpsLiveSnapshot | undefined;
    if (!data) throw new Error('The admin API did not report live operations data.');
    requireApiArray(data.movers, 'live movers');
    requireApiArray(data.activeOrders, 'active orders');
    requireApiArray(data.exhaustedSearches, 'exhausted searches');
    return data;
  });
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
    rows: requireApiArray<SlaBreach>(r.data, 'SLA breaches'),
    scanCap: requireApiNumber(r.scanCap, 'the SLA scan cap'),
    scanned: requireApiNumber(r.scanned, 'the SLA scan size'),
    truncated: (() => {
      if (typeof r.truncated !== 'boolean') throw new Error('The admin API did not report whether the SLA scan was complete.');
      return r.truncated;
    })(),
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
// [D-17] A CSAE closure carries its disposition and the evidence that
// disposition implies (A-17), and a dismissal is PROPOSED here — a second
// reviewer performs it. The body is built by lib/moderationView so the shape
// is in one place; the server decides whether it is complete.
export const resolveReport = (id: string, body: Record<string, unknown>) =>
  apiFetch(`/api/v1/admin/moderation/reports/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
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

/** Business-partner subscription types. Rider/driver rows are outside this
 * narrowly labelled count and are never silently mixed in. */
export const PARTNER_SUBSCRIPTION_TYPES = [
  'RESTAURANT', 'SUPERMARKET', 'RETAIL_STORE', 'SERVICE_PROVIDER',
] as const;

export interface PartnerPastDueSnapshot {
  /** Exact count of business subscription records whose server status is PAST_DUE. */
  statusCount: number;
}

/** The API has no waiver/custom/USD-aware amount-due aggregate. Only expose
 * the exact status count from paginated totals; money remains an explicit gap. */
export async function fetchPartnerPastDue(): Promise<PartnerPastDueSnapshot> {
  const counts = await Promise.all(PARTNER_SUBSCRIPTION_TYPES.map((type) =>
    apiFetch(`/api/v1/admin/subscriptions?status=PAST_DUE&type=${type}&page=1&limit=1`)
      .then((r) => requireApiNumber(r.meta?.total, `${type.toLowerCase()} past-due subscription total`)),
  ));

  return { statusCount: counts.reduce((sum, value) => sum + value, 0) };
}

// ── Health ───────────────────────────────────────────────────────────────────
export const fetchHealth = () =>
  fetch(`${API_ORIGIN}/health`).then(async (r) => ({ httpOk: r.ok, ...(await r.json()) }));
export const fetchDlq = () => apiFetch('/api/v1/admin/dlq').then((r) => r.data);
export const fetchAlertsHealth = () => apiFetch('/api/v1/admin/alerts/health').then((r) => r.data);
// [D-12] `acknowledgedReconciled` is the operator's statement that they checked
// a half-finishable job's outcome. The API refuses a RECONCILE_FIRST class
// without it (A-08); this console now asks for it deliberately instead of
// sending a bare retry and surfacing the refusal afterwards.
export const requeueDlqJob = (queue: string, id: string, acknowledgedReconciled = false) =>
  apiFetch(
    `/api/v1/admin/dlq/${queue}/${id}/requeue${acknowledgedReconciled ? '?acknowledgedReconciled=true' : ''}`,
    { method: 'POST', body: '{}' },
  );
export const discardDlqJob = (queue: string, id: string) =>
  apiFetch(`/api/v1/admin/dlq/${queue}/${id}`, { method: 'DELETE' });
