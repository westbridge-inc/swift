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
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.success === false) {
    // Carry the server's error CODE, not just its prose. A page that has to
    // tell "the queues are not running on this server" apart from "no jobs have
    // failed" cannot do it by matching on a sentence — and rendering the second
    // when the first is true is the UI lying about a system being healthy.
    const error = new Error(json?.error?.message || `API error: ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    if (json?.error?.code) error.code = json.error.code;
    error.status = res.status;
    throw error;
  }
  return json;
}

/** The server's error code for a thrown apiFetch error, when it sent one. */
export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? ((error as { code?: unknown }).code as string | undefined)
    : undefined;
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
  revenue: {
    /** [A-07] What active subscriptions will be BILLED this week — custom rates
     *  honoured, waived subscriptions excluded. Not cash collected. */
    weeklySubscriptionRevenue: number;
    /** [A-07] What has been waived out of that figure this period. */
    weeklySubscriptionWaived: number;
    todayDeliveryFees: number;
    todayTotal: number;
  };
  subscriptionBreakdown: {
    type: string;
    count: number;
    weeklyRevenue: number;
    waivedCount: number;
    weeklyWaived: number;
  }[];
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
// [A-12] The reason is REQUIRED — a waiver with no stated reason is revenue
// given away with no record of why.
export const waiveSubscriptionFee = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/subscriptions/${id}/waive-fee`, { method: 'PUT', body: JSON.stringify({ reason }) });
// [M-08] The server REQUIRES an Idempotency-Key on a top-up: a retry after a
// lost response returns the same result instead of crediting twice. The key
// belongs to the ATTEMPT and the page owns it — this client never mints one.
// [A-12] The provider transaction reference is REQUIRED: it is the identity of
// the money that arrived, and it is what stops one transfer being credited twice.
export const topUpSubscription = (id: string, amount: number, reference: string, idempotencyKey: string) =>
  apiFetch(`/api/v1/admin/subscriptions/${id}/topup`, {
    method: 'POST',
    body: JSON.stringify({ amount, reference }),
    headers: { 'Idempotency-Key': idempotencyKey },
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
// [A-11] The payout carries its evidence: a unique transfer reference AND the
// amount actually sent, which the server checks against the claim's own figure.
export const payClaim = (id: string, reference: string, amount: string | number) =>
  apiFetch(`/api/v1/admin/cash-rules/claims/${id}/paid`, { method: 'PUT', body: JSON.stringify({ reference, amount }) });
export const fetchCashMetrics = () => apiFetch('/api/v1/admin/cash-rules/metrics');

// ─── Support & comms ─────────────────────────────────────────────
export const fetchSupportTickets = (status?: string) =>
  apiFetch(`/api/v1/admin/support?${status ? `status=${status}` : ''}`);
/** [A-18] A close carries a disposition and the state the screen was looking at. */
export type SupportResolution = 'ANSWERED' | 'ACTION_TAKEN' | 'ESCALATED_SAFETY' | 'NO_RISK_FOUND' | 'UNABLE_TO_CONTACT';
export const resolveSupportTicket = (
  id: string,
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED',
  adminNote?: string,
  resolution?: SupportResolution,
  expectedStatus?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED',
) =>
  apiFetch(`/api/v1/admin/support/${id}/resolve`, {
    method: 'PUT',
    body: JSON.stringify({ status, adminNote, resolution, expectedStatus }),
  });
export const fetchReturns = (status?: string) =>
  apiFetch(`/api/v1/admin/returns?limit=50${status ? `&status=${status}` : ''}`);
// [A-13] "Refund" records an OBLIGATION (REFUND_DUE), not a completed payment.
// A return only reaches REFUNDED through settleReturnRefund below, with the
// transfer reference and the amount actually sent.
export const resolveReturn = (id: string, status: 'APPROVED' | 'REJECTED' | 'REFUND_DUE', note?: string) =>
  apiFetch(`/api/v1/admin/returns/${id}/resolve`, { method: 'PUT', body: JSON.stringify({ status, note }) });

/** The money actually moved: a unique transfer reference and the amount sent. */
export const settleReturnRefund = (id: string, reference: string, amount: string | number, note?: string) =>
  apiFetch(`/api/v1/admin/returns/${id}/refund-settled`, {
    method: 'PUT',
    body: JSON.stringify({ reference, amount, ...(note ? { note } : {}) }),
  });
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
// [A-14] `refund: true` records that a refund is OWED. It does not mark
// anything refunded — settleOrderRefund below is the only thing that can.
export const cancelOrder = (id: string, body: { reason: string; refund?: boolean }) =>
  apiFetch(`/api/v1/admin/orders/${id}/cancel`, { method: 'PUT', body: JSON.stringify(body) });

/** The cash actually went back: a unique reference and the amount handed over. */
export const settleOrderRefund = (id: string, reference: string, amount: string | number) =>
  apiFetch(`/api/v1/admin/orders/${id}/refund-settled`, {
    method: 'PUT',
    body: JSON.stringify({ reference, amount }),
  });
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

// STORE-001: the content-moderation queue. `POST /reports` has been filing
// reports since the UGC trio shipped, and admin.routes has exposed both halves
// of the reviewer's side the whole time — with no admin UI calling either, so
// every report a customer filed landed in a table no human could open.
export const fetchModerationReports = (status = 'PENDING', reason?: string) =>
  apiFetch(`/api/v1/admin/moderation/reports?status=${status}${reason ? `&reason=${reason}` : ''}&limit=100`);
// [A-17] A child-safety report closes with a CODED disposition and the evidence
// that disposition implies — and a dismissal is proposed by one reviewer and
// confirmed by another. Ordinary moderation still sends just a status.
export type CsaeDisposition = 'ENFORCED' | 'ENFORCED_AND_REPORTED' | 'NO_VIOLATION' | 'DUPLICATE';
export const resolveModerationReport = (
  id: string,
  body: {
    status: 'REVIEWING' | 'ACTIONED' | 'DISMISSED' | 'PROPOSE_DISMISS';
    note?: string;
    disposition?: CsaeDisposition;
    enforcementRef?: string;
    authorityRef?: string;
    evidencePreserved?: boolean;
  },
) => apiFetch(`/api/v1/admin/moderation/reports/${id}`, { method: 'PUT', body: JSON.stringify(body) });

// The OTHER two moderation queues, also without a caller until now:
// `ratings/moderation` returns both the reviews auto-HELD by the profanity
// filter (withheld from publication, waiting on a human who never came) and
// the pending RatingReports. Note the asymmetry, which the UI has to state:
// upholding a rating report REMOVES the review, while resolving a content
// report only records the decision.
export const fetchRatingsModeration = () => apiFetch('/api/v1/admin/ratings/moderation');
export const resolveRatingReport = (id: string, action: 'uphold' | 'dismiss') =>
  apiFetch(`/api/v1/admin/rating-reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) });
export const moderateRating = (
  id: string,
  body: { action: 'publish' | 'remove' | 'exclude'; reason?: string },
) => apiFetch(`/api/v1/admin/ratings/${id}/moderate`, { method: 'POST', body: JSON.stringify(body) });

// Swift Ads review — the two gates on the whole ads revenue path. An
// advertiser registers from the app and lands at PENDING_REVIEW; a creative
// uploads and lands at PENDING. Both endpoints existed with no admin caller,
// so nobody could pass either gate and no ad could ever run.
export const fetchAdvertiserQueue = (status = 'PENDING_REVIEW') =>
  apiFetch(`/api/v1/admin/ads/advertisers/queue?status=${status}`);
export const approveAdvertiser = (id: string) =>
  apiFetch(`/api/v1/admin/ads/advertisers/${id}/approve`, { method: 'PUT', body: JSON.stringify({}) });
export const rejectAdvertiser = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/ads/advertisers/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const suspendAdvertiser = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/ads/advertisers/${id}/suspend`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const reinstateAdvertiser = (id: string) =>
  apiFetch(`/api/v1/admin/ads/advertisers/${id}/reinstate`, { method: 'PUT', body: JSON.stringify({}) });

export const fetchCreativeQueue = () => apiFetch('/api/v1/admin/ads/creatives/queue');
export const approveCreative = (id: string) =>
  apiFetch(`/api/v1/admin/ads/creatives/${id}/approve`, { method: 'PUT', body: JSON.stringify({}) });
export const rejectCreative = (id: string, reason: string, notes?: string) =>
  apiFetch(`/api/v1/admin/ads/creatives/${id}/reject`, {
    method: 'PUT',
    body: JSON.stringify({ reason, ...(notes ? { notes } : {}) }),
  });

export const fetchVerificationQueue = (status = 'PENDING', role = 'operator') =>
  apiFetch(`/api/v1/admin/verification/queue?status=${status}&role=${role}&limit=100`);
export const getDocSignedUrl = (id: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/document-url`);
export const approveDoc = (id: string, body?: { expiresAt?: string; insurance?: InsuranceCheck }) =>
  apiFetch(`/api/v1/admin/verification/${id}/approve`, { method: 'PUT', body: JSON.stringify(body ?? {}) });
export const rejectDoc = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/verification/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) });

// ── Background jobs / dead letters (N4 · WS-8.1) ────────────────────────────
// GET /dlq, POST /dlq/:queue/:id/requeue and DELETE /dlq/:queue/:id have been
// registered since the mission-control spec landed, and the route-reachability
// sweep found no client anywhere calling one of them. So a background job that
// exhausted its retries — including process-billing, process-settlements and
// poll-mmg-billing — died into a list no operator could open.
export interface DeadLetter {
  queue: string;
  id: string;
  name: string;
  failedReason: string | null;
  attemptsMade: number;
  /** JSON payload preview, truncated to 500 chars server-side. */
  data: string;
  finishedOn: number | null;
}

export const fetchDeadLetters = () => apiFetch('/api/v1/admin/dlq');

// The COMPARE half of compare-and-act [REPORT-037 R037-09]. An id alone does not
// identify a job: BullMQ reuses numeric ids after a queue is obliterated and
// recreated, and a job that has since been retried is no longer a dead letter at
// all. Sending what this page actually SAW lets the server refuse (409) rather
// than act on a different job — or on a live one.
function identity(row: Pick<DeadLetter, 'name' | 'finishedOn'>): string {
  const params = new URLSearchParams({ expectedName: row.name });
  if (row.finishedOn != null) params.set('expectedFinishedOn', String(row.finishedOn));
  return `?${params.toString()}`;
}

export const requeueDeadLetter = (queue: string, id: string, row: Pick<DeadLetter, 'name' | 'finishedOn'>) =>
  apiFetch(`/api/v1/admin/dlq/${queue}/${id}/requeue${identity(row)}`, { method: 'POST' });
export const discardDeadLetter = (queue: string, id: string, row: Pick<DeadLetter, 'name' | 'finishedOn'>) =>
  apiFetch(`/api/v1/admin/dlq/${queue}/${id}${identity(row)}`, { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Category discovery governance.
//
// Eight routes, built with the taxonomy engine and reachable from nothing:
// `git grep discovery apps/admin/src` returned zero. The consequence is
// measurable — 1 of 57 live retail items carries a discovery tag, because the
// backfill that would tag them is admin-triggered and no admin could trigger
// it. Same shape as the moderation queue (#817) and the ads gates (#822).
// ---------------------------------------------------------------------------

export interface DiscoveryCategory {
  id: string;
  slug: string;
  name: string;
  emoji: string | null;
  iconKey: string | null;
  aliases: string[];
  kind: string;
  vertical: string;
  status: 'ACTIVE' | 'HIDDEN';
  sortWeight: number;
  mergedIntoId: string | null;
}

export interface DiscoveryRequest {
  id: string;
  vendorId: string;
  vendorName: string | null;
  proposedName: string;
  note: string | null;
  status: 'PENDING' | 'APPROVED' | 'MERGED' | 'REJECTED';
  createdAt: string;
  resolutionNote: string | null;
}

export const fetchDiscoveryCategories = () => apiFetch('/api/v1/admin/discovery/categories');
export const fetchDiscoveryRequests = (status: string) =>
  apiFetch(`/api/v1/admin/discovery/requests?status=${status}`);

export const updateDiscoveryCategory = (
  id: string,
  body: Partial<Pick<DiscoveryCategory, 'name' | 'emoji' | 'iconKey' | 'aliases' | 'sortWeight' | 'status'>>,
) => apiFetch(`/api/v1/admin/discovery/categories/${id}`, { method: 'PUT', body: JSON.stringify(body) });

/** Approve a vendor's request as a NEW category. `emoji`, `kind` and `vertical`
 *  are required by the route — kind and vertical against enums, so the page
 *  offers selects and never a text box. */
export const approveDiscoveryRequest = (
  id: string,
  body: { name?: string; emoji: string; kind: string; vertical: string },
) => apiFetch(`/api/v1/admin/discovery/requests/${id}/approve`, { method: 'POST', body: JSON.stringify(body) });

/** Resolve a request onto an EXISTING category instead of minting a near-duplicate. */
export const mapDiscoveryRequest = (id: string, targetSlug: string) =>
  apiFetch(`/api/v1/admin/discovery/requests/${id}/map`, { method: 'POST', body: JSON.stringify({ targetSlug }) });

/** Reject with a reason the vendor is shown VERBATIM (route: 3–300 chars). */
export const rejectDiscoveryRequest = (id: string, reason: string) =>
  apiFetch(`/api/v1/admin/discovery/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });

/** Merge a category into another. `mergedIntoId` is why an existing slug is
 *  never edited — the redirect is the migration. */
export const mergeDiscoveryCategory = (id: string, targetId: string) =>
  apiFetch(`/api/v1/admin/discovery/categories/${id}/merge-into`, { method: 'POST', body: JSON.stringify({ targetId }) });

/** Enqueue the backfill. Returns 503 QUEUES_OFF when the worker fleet is not
 *  running — a real and expected state, not a generic failure, so the page says
 *  so in those words. */
export const runDiscoveryBackfill = () =>
  apiFetch('/api/v1/admin/discovery/backfill', { method: 'POST' });

// ── Integrity review (the algorithms' decision log) ─────────────────────────

/** One row from the integrity decision log. `sentence` is the reviewer-facing
 *  prose (≤240 chars) and is rendered VERBATIM — the `inputs` evidence Json
 *  (signal tokens and all) rides the wire but stays OUT of the UI, so the
 *  detection tells never leak into a screenshot. */
export type IntegrityFlag = {
  id: string;
  algo: string;
  subjectType: 'ORDER' | 'RIDER' | 'DRIVER' | 'VENDOR' | 'CUSTOMER' | 'ITEM';
  subjectId: string;
  outcome: string;
  sentence: string;
  inputs: unknown;
  configVersion: string;
  createdAt: string;
};

/** Newest first, shadow rows never listed, SUPER_ADMIN only — the server's
 *  platformControlGuard decides, so a 403 here is the truth, not a bug.
 *  Route contract: algo must match ALG-\d{1,3}, days 1..90, limit 1..200. */
export const fetchIntegrityFlags = (params: {
  algo?: string;
  subjectType?: string;
  subjectId?: string;
  days?: number;
  limit?: number;
}) => {
  const qs = new URLSearchParams();
  if (params.algo) qs.set('algo', params.algo);
  if (params.subjectType) qs.set('subjectType', params.subjectType);
  if (params.subjectId) qs.set('subjectId', params.subjectId);
  qs.set('days', String(params.days ?? 7));
  qs.set('limit', String(params.limit ?? 50));
  return apiFetch(`/api/v1/admin/integrity/flags?${qs.toString()}`);
};
