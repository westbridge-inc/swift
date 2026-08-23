const API_URL = process.env['NEXT_PUBLIC_API_URL'] || 'http://localhost:3000';

// ── Token store (localStorage — SEC-11 accepted V1 risk) ────────────────────
const ACCESS_KEY = 'swift_admin_token';
const REFRESH_KEY = 'swift_admin_refresh';

export function getToken() {
  return typeof window !== 'undefined' ? localStorage.getItem(ACCESS_KEY) : null;
}
export function setTokens(accessToken: string, refreshToken?: string | null) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}
export function clearTokens() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

// Access tokens live 30m; transparently refresh on 401 so admins aren't kicked
// out mid-session (refresh token lasts 7d). Mirrors the mobile client.
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

async function apiFetch(path: string, options?: RequestInit) {
  const doFetch = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...options?.headers,
      },
    });

  let res = await doFetch(getToken());
  if (res.status === 401) {
    const fresh = await tryRefresh();
    if (fresh) res = await doFetch(fresh);
    if (res.status === 401) {
      clearTokens();
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      throw new Error('Session expired. Please sign in again.');
    }
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ── Auth (public endpoints — no admin token) ────────────────────────────────
const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];

export async function sendOtp(phone: string) {
  const res = await fetch(`${API_URL}/api/v1/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(json?.error?.message || 'Could not send a code to that number.');
  }
  return json.data;
}

/** Verify the OTP, enforce an admin role, and persist the session. Returns the user. */
export async function verifyOtpLogin(phone: string, code: string) {
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
  setTokens(data.tokens.accessToken, data.tokens.refreshToken);
  return data.user;
}

// ── Typed responses (catch frontend↔backend shape drift at compile time) ────
export interface Envelope<T> {
  success: boolean;
  data: T;
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
  revenue: { weeklySubscriptionRevenue: number; todayDeliveryFees: number; todayTotal: number };
  subscriptionBreakdown: { type: string; count: number; weeklyRevenue: number }[];
  alerts: { pendingVendors: number; pastDueSubs: number; unassignedOrders: number };
}

export interface RevenueResponse {
  dailyRevenue: { date: string; markup: number; delivery_fees: number; total: number; order_count: number }[];
  summary: {
    thirtyDayMarkup: number;
    thirtyDayDeliveryFees: number;
    weeklySubscriptionRevenue: number;
    monthlySubscriptionRevenue: number;
    activeSubscriptions: number;
  };
}

export interface ConfigRow {
  id: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface AdminUser {
  id: string;
  phone: string;
  email: string | null;
  firstName: string;
  lastName: string;
  avatar: string | null;
  roles: string[];
  activeRole: string;
  status: string;
  isPhoneVerified: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

export interface Promo {
  id: string;
  code: string;
  description: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY';
  discountValue: number;
  minOrderAmount: number | null;
  maxDiscount: number | null;
  maxUses: number | null;
  currentUses: number;
  isActive: boolean;
  validFrom: string;
  validUntil: string;
}

export const fetchDashboard = (): Promise<Envelope<DashboardOverview>> =>
  apiFetch('/api/v1/admin/dashboard/overview');
export const fetchRecentOrders = () => apiFetch('/api/v1/admin/orders?limit=20');
export const fetchUsers = (params?: string): Promise<Envelope<AdminUser[]>> =>
  apiFetch(`/api/v1/admin/users?${params || ''}`);
export const fetchVendors = (status?: string) => apiFetch(`/api/v1/admin/vendors${status ? `?status=${status}` : ''}`);
export const fetchPendingVendors = () => apiFetch('/api/v1/admin/vendors/pending');
export const fetchRiders = () => apiFetch('/api/v1/admin/riders');
export const fetchDrivers = () => apiFetch('/api/v1/admin/drivers');
export const fetchOrders = (params?: string) => apiFetch(`/api/v1/admin/orders?${params || ''}`);
export const fetchOrderDetail = (id: string) => apiFetch(`/api/v1/admin/orders/${id}`);

// ─── Detail pages (People phase) ─────────────────────────────────
export const fetchUserDetail = (id: string) => apiFetch(`/api/v1/admin/users/${id}`);
export const fetchVendorDetail = (id: string) => apiFetch(`/api/v1/admin/vendors/${id}`);
export const fetchRiderDetail = (id: string) => apiFetch(`/api/v1/admin/riders/${id}`);
export const fetchDriverDetail = (id: string) => apiFetch(`/api/v1/admin/drivers/${id}`);
export const banUser = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/users/${id}/ban`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const suspendVendor = (id: string, reason?: string) =>
  apiFetch(`/api/v1/admin/vendors/${id}/suspend`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const featureVendor = (id: string, featured: boolean) =>
  apiFetch(`/api/v1/admin/vendors/${id}/feature`, { method: 'PUT', body: JSON.stringify({ featured }) });

// ─── Money center ────────────────────────────────────────────────
export const fetchSubscriptions = (params?: string) => apiFetch(`/api/v1/admin/subscriptions?${params || 'limit=50'}`);
export const waiveSubscriptionFee = (id: string, reason?: string) =>
  apiFetch(`/api/v1/admin/subscriptions/${id}/waive-fee`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const topUpSubscription = (id: string, amount: number, reference?: string, idempotencyKey?: string) =>
  apiFetch(`/api/v1/admin/subscriptions/${id}/topup`, {
    method: 'POST',
    body: JSON.stringify({ amount, reference }),
    // [WR-002] Without this header the server falls back to a time-based key —
    // its own comment calls that "opted out of dedup" — so a double-tap or
    // network retry could credit twice.
    ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
  });
export const fetchBillingEvents = (id: string) => apiFetch(`/api/v1/admin/subscriptions/${id}/billing-events?limit=20`);
export const fetchSettlements = (params?: string) => apiFetch(`/api/v1/admin/finance/settlements?${params || 'limit=50'}`);
export const processSettlement = (id: string, reference?: string) =>
  apiFetch(`/api/v1/admin/finance/settlements/${id}/process`, { method: 'PUT', body: JSON.stringify({ reference }) });
export const fetchClaims = (status?: string) =>
  apiFetch(`/api/v1/admin/cash-rules/claims?limit=50${status ? `&status=${status}` : ''}`);
export const approveClaim = (id: string, reason?: string) =>
  apiFetch(`/api/v1/admin/cash-rules/claims/${id}/approve`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const rejectClaim = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/cash-rules/claims/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const payClaim = (id: string, reference: string) =>
  apiFetch(`/api/v1/admin/cash-rules/claims/${id}/paid`, { method: 'PUT', body: JSON.stringify({ reference }) });
export const fetchCashMetrics = () => apiFetch('/api/v1/admin/cash-rules/metrics');

// ─── Support & comms ─────────────────────────────────────────────
export const fetchSupportTickets = (status?: string) =>
  apiFetch(`/api/v1/admin/support?${status ? `status=${status}` : ''}`);
export const resolveSupportTicket = (id: string, status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED', adminNote?: string) =>
  apiFetch(`/api/v1/admin/support/${id}/resolve`, { method: 'PUT', body: JSON.stringify({ status, adminNote }) });
export const fetchReturns = (status?: string) =>
  apiFetch(`/api/v1/admin/returns?limit=50${status ? `&status=${status}` : ''}`);
export const resolveReturn = (id: string, status: 'APPROVED' | 'REJECTED' | 'REFUNDED', note?: string) =>
  apiFetch(`/api/v1/admin/returns/${id}/resolve`, { method: 'PUT', body: JSON.stringify({ status, note }) });
export const broadcastNotification = (body: { title: string; body: string; role?: string; category: 'service' | 'marketing' }) =>
  apiFetch('/api/v1/admin/notifications/broadcast', { method: 'POST', body: JSON.stringify(body) });

// ─── Live ops + markets ──────────────────────────────────────────
export interface LiveOps {
  movers: { id: string; kind: 'rider' | 'driver'; lat: number; lng: number; name: string; busy: boolean; rideClass?: string }[];
  activeOrders: {
    id: string;
    orderNumber: string;
    status: string;
    orderType: string;
    pickupLat: number | null;
    pickupLng: number | null;
    deliveryLat: number | null;
    deliveryLng: number | null;
    vendorName: string | null;
  }[];
}
export const fetchLiveOps = (): Promise<Envelope<LiveOps>> => apiFetch('/api/v1/admin/ops/live');
export const fetchCountries = () => apiFetch('/api/v1/admin/countries');

// ─── Ops agent ───────────────────────────────────────────────────
export const fetchAgentApprovals = (status = 'PENDING') =>
  apiFetch(`/api/v1/admin/agent/approvals?status=${status}`);
export const decideAgentApproval = (id: string, approve: boolean) =>
  apiFetch(`/api/v1/admin/agent/approvals/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: '{}' });
export const fetchAgentAudit = () => apiFetch('/api/v1/admin/agent/audit?limit=50');

// ─── Compliance (liability shield) ───────────────────────────────
export const fetchCompliance = () => apiFetch('/api/v1/admin/compliance');
export const runComplianceAudit = () => apiFetch('/api/v1/admin/compliance/run', { method: 'POST', body: '{}' });
export const decideComplianceReview = (id: string, pass: boolean, note?: string) =>
  apiFetch(`/api/v1/admin/compliance/reviews/${id}/decide`, { method: 'POST', body: JSON.stringify({ pass, ...(note ? { note } : {}) }) });
export const resolveComplianceViolation = (id: string) =>
  apiFetch(`/api/v1/admin/compliance/violations/${id}/resolve`, { method: 'POST', body: '{}' });

// ─── Global ⌘K search ────────────────────────────────────────────
export interface GlobalSearchResult {
  orders: { id: string; orderNumber: string; status: string; orderType: string; totalAmount: number; placedAt: string }[];
  users: { id: string; firstName: string; lastName: string; phone: string; roles: string[]; status: string }[];
  vendors: { id: string; name: string; vendorType: string; status: string; city: string }[];
}
export const fetchGlobalSearch = (q: string): Promise<Envelope<GlobalSearchResult>> =>
  apiFetch(`/api/v1/admin/search?q=${encodeURIComponent(q)}`);
export const fetchRevenue = (): Promise<Envelope<RevenueResponse>> =>
  apiFetch('/api/v1/admin/finance/revenue');

// ─── MMG direct-pay visibility (Swift moves no money) ────────────
export interface CashSettlementRow {
  id: string;
  orderId: string;
  orderNumber: string | null;
  amount: number;
  status: 'OWED' | 'RIDER_CONFIRMED' | 'STORE_CONFIRMED' | 'SETTLED';
  riderConfirmedAt: string | null;
  storeConfirmedAt: string | null;
  createdAt: string;
  vendor: { id: string; name: string } | null;
  rider: { id: string; name: string } | null;
}
export interface CashSettlementsResponse {
  success: boolean;
  data: CashSettlementRow[];
  meta: { page: number; limit: number; total: number; totalPages: number };
  /** Unfiltered totals per status — the platform-wide ledger health. */
  summary: Partial<Record<CashSettlementRow['status'], { total: number; count: number }>>;
}
export const fetchCashSettlements = (params?: string): Promise<CashSettlementsResponse> =>
  apiFetch(`/api/v1/admin/finance/cash-settlements?${params || 'limit=50'}`);

export interface PaymentMix {
  byMethod: { method: string; count: number; total: number }[];
  /** Delivered MMG orders the vendor never marked received — follow up. */
  mmgUnconfirmed: number;
}
export const fetchPaymentMix = (): Promise<Envelope<PaymentMix>> =>
  apiFetch('/api/v1/admin/finance/payment-mix');
export const fetchPromos = (): Promise<Envelope<Promo[]>> => apiFetch('/api/v1/admin/promos');

export interface CreatePromoInput {
  code: string;
  description: string;
  discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY';
  discountValue: number;
  validFrom: string;
  validUntil: string;
  minOrderAmount?: number;
  maxUses?: number;
  maxUsesPerUser?: number;
}
export const createPromo = (body: CreatePromoInput) =>
  apiFetch('/api/v1/admin/promos', { method: 'POST', body: JSON.stringify(body) });
export const fetchConfig = (): Promise<Envelope<ConfigRow[]>> => apiFetch('/api/v1/admin/config');
export const fetchAuditLogs = (params?: string) => apiFetch(`/api/v1/admin/audit-logs?${params || 'limit=50'}`);

export const approveVendor = (id: string) => apiFetch(`/api/v1/admin/vendors/${id}/approve`, { method: 'PUT' });
export const verifyRiderDocuments = (id: string) => apiFetch(`/api/v1/admin/riders/${id}/verify-documents`, { method: 'PUT' });
export const verifyDriverDocuments = (id: string) => apiFetch(`/api/v1/admin/drivers/${id}/verify-documents`, { method: 'PUT' });
export const setDriverRideClass = (id: string, rideClass: string) =>
  apiFetch(`/api/v1/admin/drivers/${id}/ride-class`, { method: 'PUT', body: JSON.stringify({ rideClass }) });
export const cancelOrder = (id: string, body: { reason: string; refund?: boolean }) =>
  apiFetch(`/api/v1/admin/orders/${id}/cancel`, { method: 'PUT', body: JSON.stringify(body) });
export const suspendUser = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/users/${id}/suspend`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const unsuspendUser = (id: string) =>
  apiFetch(`/api/v1/admin/users/${id}/unsuspend`, { method: 'PUT', body: JSON.stringify({}) });
export const updateConfig = (key: string, value: unknown) =>
  apiFetch(`/api/v1/admin/config/${key}`, { method: 'PUT', body: JSON.stringify({ value }) });

// ─── Verification Center ─────────────────────────────────────────
export interface InsuranceCheck {
  insurerName: string;
  policyNumber: string;
  coverageClass: 'HIRE' | 'PRIVATE';
  hireClassConfirmed: boolean;
  plateCrossChecked: boolean;
}

export const fetchVerificationQueue = (status = 'PENDING') =>
  apiFetch(`/api/v1/admin/verification/queue?status=${status}&limit=100`);
export const getDocSignedUrl = (id: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/document-url`);
export const approveDoc = (id: string, body?: { expiresAt?: string; insurance?: InsuranceCheck }) =>
  apiFetch(`/api/v1/admin/verification/${id}/approve`, { method: 'PUT', body: JSON.stringify(body ?? {}) });
export const rejectDoc = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) });
