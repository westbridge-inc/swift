import axios, { type AxiosRequestConfig } from 'axios';
import {
  getAuthSessionSnapshot,
  isAuthSessionSnapshotCurrent,
  useAuthStore,
} from '../stores/authStore';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { AuthRefreshCoordinator, type AuthSessionSnapshot } from '../lib/authSession';

// Build-time override (set per EAS build profile, e.g. preview→staging,
// production→prod). Falls back to localhost in dev and the prod domain otherwise.
// eslint-disable-next-line no-undef
export const API_URL = process.env['EXPO_PUBLIC_API_URL'] ?? (__DEV__ ? 'http://localhost:3000' : 'https://api.swift.gy');

/** [B9] Where PUBLIC share links point — the web app, never the API. Used by
 *  parcel tracking (`/track/:token`); trip shares join it when they move off
 *  the text-only share. Overridable per EAS profile like API_URL. (`__DEV__`
 *  is typeof-guarded: unlike API_URL's, this line actually evaluates in the
 *  node test env, where the RN global does not exist.) */
// eslint-disable-next-line no-undef
export const WEB_URL = process.env['EXPO_PUBLIC_WEB_URL'] ?? (typeof __DEV__ !== 'undefined' && __DEV__ ? 'http://localhost:3001' : 'https://swift.gy');

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

type AuthBindingConfig = AxiosRequestConfig & {
  _swiftAuthBindingId?: string;
};

interface RequestAuthBinding {
  session: AuthSessionSnapshot;
  refreshRetry: boolean;
}

// Axios copies unknown enumerable config fields while merging defaults. Putting
// the full auth snapshot there made refresh credentials visible to adapters,
// error serializers, and telemetry. Only an opaque, one-use identifier crosses
// that merge; the credential-bearing binding remains module-private and is
// attached to the merged request through a WeakMap before the adapter runs.
const pendingAuthBindings = new Map<string, RequestAuthBinding>();
const requestAuthBindings = new WeakMap<object, RequestAuthBinding>();
const authRefreshRetries = new WeakSet<object>();
let nextAuthBindingId = 0;

function registerAuthBinding(
  session: AuthSessionSnapshot,
  refreshRetry = false,
): string {
  nextAuthBindingId += 1;
  const id = `swift-auth-${nextAuthBindingId}`;
  pendingAuthBindings.set(id, { session, refreshRetry });
  return id;
}

function consumeAuthBinding(config: AuthBindingConfig): RequestAuthBinding | null {
  const id = config._swiftAuthBindingId;
  if (!id) return null;
  delete config._swiftAuthBindingId;
  const binding = pendingAuthBindings.get(id) ?? null;
  pendingAuthBindings.delete(id);
  return binding;
}

/** Pin a request to the exact principal snapshot that authorized its caller.
 * Axios request interceptors may run on a later microtask; an explicit header
 * prevents a stale callback from borrowing a newly logged-in account's token,
 * while the captured snapshot keeps safe refresh/retry behavior intact. */
function capturedAuthConfig(
  session?: AuthSessionSnapshot,
  config?: AxiosRequestConfig,
): AuthBindingConfig | undefined {
  if (!session) return config;
  return {
    ...config,
    headers: {
      ...config?.headers,
      Authorization: `Bearer ${session.accessToken}`,
    },
    _swiftAuthBindingId: registerAuthBinding(session),
  };
}

function capturedVendorAuthConfig(
  session?: AuthSessionSnapshot,
  storeId?: string | null,
  config?: AxiosRequestConfig,
): AuthBindingConfig | undefined {
  return capturedAuthConfig(session, storeId ? {
    ...config,
    headers: {
      ...config?.headers,
      'x-vendor-id': storeId,
    },
  } : config);
}

// Request interceptor to attach auth token
api.interceptors.request.use((config) => {
  const session = getAuthSessionSnapshot();
  const binding = consumeAuthBinding(config as AuthBindingConfig);
  const authorization = config.headers.get('Authorization');
  // Explicit Authorization headers (logout/push handoff, referral after
  // registration) are already pinned by their caller and must not be replaced
  // with whichever account happens to be current a tick later.
  if (binding) {
    requestAuthBindings.set(config, binding);
    if (binding.refreshRetry) authRefreshRetries.add(config);
  } else if (session && !authorization) {
    config.headers.set('Authorization', `Bearer ${session.accessToken}`);
    requestAuthBindings.set(config, { session, refreshRetry: false });
  } else if (session && authorization === `Bearer ${session.accessToken}`) {
    // A caller may pin the current access token explicitly. It remains safe to
    // refresh only while that exact session is still current.
    requestAuthBindings.set(config, { session, refreshRetry: false });
  }
  // Multi-store switch — scope vendor requests to the selected store.
  const storeId = useStoreSwitcher.getState().selectedStoreId;
  // A refresh retry carries the tenant selected when the operation began.
  // Never retarget that replay if the manager switched stores meanwhile.
  if (storeId && !config.headers.get('x-vendor-id')) {
    config.headers.set('x-vendor-id', storeId);
  }
  return config;
}, undefined, { synchronous: true });

// Response interceptor for token refresh. The coordinator single-flights an
// exact session, but lets a newly logged-in account start its own flight. Every
// rotate/logout is compare-and-swap bound to the user + generation + refresh
// token captured when the original request left the device.
const refreshCoordinator = new AuthRefreshCoordinator(
  {
    current: getAuthSessionSnapshot,
    rotateTokensIfCurrent: (expected, tokens) =>
      useAuthStore.getState().rotateTokensIfCurrent(expected, tokens),
    logoutIfCurrent: (expected) => useAuthStore.getState().logoutIfCurrent(expected),
  },
  async (refreshToken) => {
    const { data } = await axios.post(
      `${API_URL}/api/v1/auth/refresh`,
      { refreshToken },
      { timeout: api.defaults.timeout },
    );
    const tokens = data?.data;
    if (typeof tokens?.accessToken !== 'string' || typeof tokens?.refreshToken !== 'string') {
      throw new Error('Refresh response did not contain a token pair');
    }
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  },
  (error) => axios.isAxiosError(error)
    && (error.response?.status === 401 || error.response?.status === 403),
);

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config as
      | (AxiosRequestConfig & {
          _swiftAuthBindingId?: string;
          headers?: Record<string, any>;
        })
      | undefined;
    const captured = originalRequest
      ? requestAuthBindings.get(originalRequest)?.session
      : undefined;
    if (
      error.response?.status === 401
      && originalRequest
      && captured
      && !authRefreshRetries.has(originalRequest)
    ) {
      const outcome = await refreshCoordinator.resolve(captured);
      // Re-check after awaiting: logout or account B may have won while the
      // refresh POST was in flight. A stale request is rejected, never retried.
      if (outcome && isAuthSessionSnapshotCurrent(outcome.session)) {
        originalRequest.headers ??= {};
        originalRequest.headers['Authorization'] = `Bearer ${outcome.accessToken}`;
        const bindingId = registerAuthBinding(outcome.session, true);
        originalRequest._swiftAuthBindingId = bindingId;
        try {
          return await api(originalRequest);
        } finally {
          // Axios merges the config synchronously before running interceptors.
          // Remove the dead opaque carrier from the original error object too.
          delete originalRequest._swiftAuthBindingId;
          pendingAuthBindings.delete(bindingId);
        }
      }
    }
    return Promise.reject(error);
  },
);

/** Revoke the exact captured server session after local logout. The refresh
 * credential is stable across the one possible concurrent rotation: the API
 * accepts its current or immediately previous value under the same row lock.
 * Raw axios prevents a newer account from being substituted by an interceptor. */
export async function revokeAuthSession(refreshToken: string, pushToken: string | null): Promise<void> {
  await axios.post(
    `${API_URL}/api/v1/auth/logout/refresh`,
    { refreshToken, ...(pushToken ? { pushToken } : {}) },
    {
      timeout: api.defaults.timeout,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

// Auth
export const authApi = {
  sendOtp: (phone: string) => api.post('/auth/send-otp', { phone }),
  verifyOtp: (phone: string, code: string) => api.post('/auth/verify-otp', { phone, code }),
  countries: () => api.get('/auth/countries'),
  // Public weekly price list — the pitch partners see BEFORE committing.
  pricing: (country?: string) => api.get('/auth/pricing', { params: country ? { country } : undefined }),
  register: (data: {
    phone: string;
    firstName: string;
    lastName: string;
    email?: string;
    role?: 'CUSTOMER' | 'MOVER' | 'VENDOR';
    countryCode?: string;
    /** Server records consent + the legal version it covered [SWIFT-AUD-D9-03]. */
    acceptTerms?: boolean;
  }) => api.post('/auth/register', data),
  refresh: (refreshToken: string) => api.post('/auth/refresh', { refreshToken }),
  logout: () => api.post('/auth/logout'),
  // Mandatory signup selfie — multipart camera capture; becomes the public photo.
  uploadSelfie: (form: FormData, session?: AuthSessionSnapshot) =>
    api.post('/auth/selfie', form, capturedAuthConfig(session, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })),
};

// Customer
export interface AddressInput {
  label: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  region?: string;
  latitude: number;
  longitude: number;
  instructions?: string;
  isDefault?: boolean;
}

export type SupportCategory = 'ORDER_ISSUE' | 'PAYMENT' | 'SAFETY' | 'ACCOUNT' | 'VENDOR' | 'MOVER' | 'OTHER';

// Category discovery rail + feed (#17) — public, flag-gated server-side.
export const discoveryApi = {
  categories: (params?: { vertical?: string; lat?: number; lng?: number }) =>
    api.get('/discovery/categories', { params }),
};

export const customerApi = {
  getProfile: () => api.get('/customer/profile'),
  myRating: () => api.get('/customer/rating'),
  updateProfile: (
    data: { firstName?: string; lastName?: string; email?: string },
    session?: AuthSessionSnapshot,
  ) => api.put('/customer/profile', data, capturedAuthConfig(session)),
  // [DCR-1 NR1-03] Consent surface: read current states; grant/withdraw
  // marketing. Every change is an append-only ledger row server-side.
  getConsent: () => api.get('/customer/consent'),
  setMarketingConsent: (granted: boolean, session?: AuthSessionSnapshot) =>
    api.post('/customer/consent/marketing', { granted }, capturedAuthConfig(session)),
  // DPA-2023 self-serve rights (D9-05): export your data; erase your account.
  exportAccount: (session?: AuthSessionSnapshot) =>
    api.get('/customer/account/export', capturedAuthConfig(session)),
  deleteAccount: (session?: AuthSessionSnapshot) =>
    api.delete('/customer/account', capturedAuthConfig(session)),
  switchRole: (role: string, session?: AuthSessionSnapshot) =>
    api.post('/customer/switch-role', { role }, capturedAuthConfig(session)),
  // In-app support / dispute channel.
  createTicket: (data: { category: SupportCategory; subject: string; message: string; orderId?: string }) =>
    api.post('/customer/support', data),
  supportTickets: () => api.get('/customer/support'),
  // Post-delivery tip (100% to the mover).
  tipOrder: (id: string, amount: number, session?: AuthSessionSnapshot) =>
    api.post(`/customer/orders/${id}/tip`, { amount }, capturedAuthConfig(session)),
  // Live verdict on an out-of-stock substitution the store proposed (§5.3).
  decideSubstitution: (orderId: string, lineId: string, approve: boolean) =>
    api.post(`/customer/orders/${orderId}/items/${lineId}/substitution`, { approve }),
  // Redeem a referral code (writes referredBy). `token` lets a just-registered
  // user redeem before the auth store has propagated.
  redeemReferral: (code: string, token?: string) =>
    api.post('/customer/referral/redeem', { code }, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined),
  getAddresses: () => api.get('/customer/addresses'),
  addAddress: (data: AddressInput) => api.post('/customer/addresses', data),
  // The address book was append-only from the app: these three routes were
  // built, owner-scoped and tested server-side, and nothing ever called them.
  updateAddress: (id: string, data: Partial<AddressInput>) => api.put(`/customer/addresses/${id}`, data),
  deleteAddress: (id: string) => api.delete(`/customer/addresses/${id}`),
  setDefaultAddress: (id: string) => api.put(`/customer/addresses/${id}/default`),
  getHome: (lat?: number, lng?: number) => api.get('/customer/home', { params: { lat, lng } }),
  getVendors: (params?: Record<string, string>) => api.get('/customer/vendors', { params }),
  // [B2] The search ENGINE — typo tolerance, ranking, and dishes. One wire
  // contract whichever backend answered (the route normalizes Meili + DB).
  search: (q: string, opts?: { type?: string; lat?: number; lng?: number }) =>
    api.get('/search', { params: { q, ...opts } }),
  searchSuggestions: (q: string) => api.get('/search/suggestions', { params: { q } }),
  searchTrending: () => api.get('/search/trending'),
  getVendor: (id: string) => api.get(`/customer/vendors/${id}`),
  getVendorReviews: (id: string) => api.get(`/customer/vendors/${id}/reviews`),
  getItemSlots: (itemId: string, date: string) => api.get(`/customer/items/${itemId}/slots`, { params: { date } }),
  getFavorites: () => api.get('/customer/favorites'),
  addFavorite: (vendorId: string) => api.post(`/customer/favorites/${vendorId}`, {}),
  removeFavorite: (vendorId: string) => api.delete(`/customer/favorites/${vendorId}`),
  getOrders: (page?: number) => api.get('/customer/orders', page ? { params: { page } } : undefined),
  validatePromo: (code: string) => api.post('/customer/promo/validate', { code }),
  getOrder: (id: string) => api.get(`/customer/orders/${id}`),
  // [REPORT-012 F-012-03] Unwrap the API envelope AT THE SEAM: the server
  // returns { success, data: { message, cancellationFee } } inside the axios
  // body — reading one level short silently discarded the authoritative
  // cancellation outcome and the fee actually charged.
  cancelOrder: (id: string, reason?: string) =>
    api.post(`/customer/orders/${id}/cancel`, { reason })
      .then((res) => (res.data?.data ?? {}) as { message?: string; cancellationFee?: number }),
  // Order placement = checkout; it reads the server-side cart. (The old POST
  // /customer/orders had no backend route.)
  placeOrder: (data: {
    paymentMethod?: string;
    deliveryInstructions?: string;
    tipAmount?: number;
    scheduledFor?: string;
    promoCode?: string;
    fulfillmentSelections?: Record<string, 'DELIVERY' | 'PICKUP'>;
    /** Priority delivery: 1.5x delivery fee, dispatched first */
    express?: boolean;
  }) =>
    // Idempotency-Key: transport-level duplicates of ONE tap can't double-
    // order (the server refuses a concurrent twin and replays a finished one).
    api.post('/customer/checkout', data, {
      headers: { 'Idempotency-Key': `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}` },
    }),
  getNotifications: () => api.get('/customer/notifications'),
  reorder: (id: string) => api.post(`/customer/orders/${id}/reorder`, {}),
  ratingTags: () => api.get('/customer/rating-tags'),
  itemFeedback: (id: string, body: { itemId: string; verdict: 'UP' | 'DOWN' }) =>
    api.post(`/customer/orders/${id}/item-feedback`, body),
  rateOrder: (
    id: string,
    body: {
      vendorScore?: number;
      vendorComment?: string;
      riderScore?: number;
      riderComment?: string;
      driverScore?: number;
      driverComment?: string;
    },
    session?: AuthSessionSnapshot,
  ) => api.post(`/customer/orders/${id}/rate`, body, capturedAuthConfig(session)),
  // Cart
  getCart: (lat?: number, lng?: number) => api.get('/customer/cart', { params: { lat, lng } }),
  addToCart: (data: {
    vendorId: string;
    itemId: string;
    quantity?: number;
    selectedOptions?: Record<string, unknown>;
    specialInstructions?: string;
  }) => api.post('/customer/cart/items', data),
  updateCartItem: (
    id: string,
    data: { quantity: number; selectedOptions?: Record<string, unknown>; specialInstructions?: string },
  ) => api.put(`/customer/cart/items/${id}`, data),
  removeCartItem: (id: string) => api.delete(`/customer/cart/items/${id}`),
  clearCart: () => api.delete('/customer/cart'),
  setCartAddress: (addressId: string) => api.put('/customer/cart/address', { addressId }),
  setCartTip: (amount: number) => api.put('/customer/cart/tip', { amount }),
};

// Taxi / rides (mounted at /api/v1/rides)
type Point = { lat: number; lng: number };
export type RideClass = 'ECONOMY' | 'COMFORT' | 'XL' | 'GROUP';
export interface TierEstimate {
  rideClass: RideClass;
  fare: number;
  multiplier: number;
  capacity: number;
  source: 'zone_table' | 'formula';
}
export interface TieredEstimate {
  tiers: TierEstimate[];
  currencyCode: string;
  distanceKm: number;
  durationMin: number;
}
/** Customer-side safety surfaces [safety spec / rides 12.2] — thin client
 *  over the ONE safety engine; zero safety logic lives on the phone. */
export const safetyApi = {
  /** Wrong person/car at the kerb: releases the ride, re-dispatches, locks
   *  the driver pending identity review, opens the incident. */
  notMyDriver: (rideId: string) => api.post(`/safety/rides/${rideId}/not-my-driver`, {}),
  /** Trip Guardian check-in response (prompted via the guardian:checkin
   *  socket event on the order room). */
  guardianCheckin: (response: 'OK' | 'NEED_HELP') => api.post('/safety/guardian/checkin', { response }),

  /**
   * Raise an emergency alert on ANY job — the general safety path.
   *
   * `POST /safety/sos` has existed, complete and careful, since the safety
   * engine was built: it lifts the rate limit so a panicking person tapping
   * repeatedly is never answered with a 429, it is idempotent on
   * `clientIdempotencyKey` so repeats collapse into one alert instead of
   * flooding ops, and it authorises the customer, the driver OR the rider on
   * the order. It had ZERO callers on every surface. A whole life-safety
   * engine with no button.
   *
   * `/rides/:id/sos` stays the path for taxi rides — it is live, it works, and
   * an emergency route that already functions is not a thing to re-plumb for
   * tidiness. This is for everyone the ride route never covered: delivery
   * riders, couriers, service providers and their customers.
   *
   * `clientIdempotencyKey` must be STABLE across repeat presses of the same
   * emergency — the whole point is that a frightened person hitting the button
   * four times raises one alert, not four. Callers hold it for the incident,
   * never regenerate per tap.
   */
  sos: (input: {
    orderId?: string;
    /** [B3] hired-professional visit — mutually exclusive with orderId */
    serviceJobId?: string;
    lat?: number;
    lng?: number;
    accuracyM?: number;
    clientIdempotencyKey: string;
  }) => api.post('/safety/sos', { ...input, source: 'BUTTON' as const, clientCreatedAt: new Date().toISOString() }),
};

export const rideApi = {
  estimate: (pickup: Point, dropoff: Point) => api.post('/rides/estimate', { pickup, dropoff }),
  // Availability spec §1/§2.1: buckets only (GOOD/LOW/NONE), never counts.
  availability: (p: Point) => api.get(`/rides/availability?lat=${p.lat}&lng=${p.lng}`),
  watchAvailability: (p: Point) => api.post('/rides/availability/watch', p),
  // 5.5 queue [rides spec]: honest counts + the waitlist that auto-requests.
  supply: (p: Point) => api.get(`/rides/supply?lat=${p.lat}&lng=${p.lng}`),
  queueJoin: (data: {
    pickup: Point;
    dropoff: Point;
    pickupAddress: string;
    dropoffAddress: string;
    passengerCount?: number;
    rideClass?: RideClass;
  }) => api.post('/rides/queue/join', data),
  queueLeave: () => api.post('/rides/queue/leave', {}),
  queueStatus: () => api.get('/rides/queue'),
  request: (data: {
    pickup: Point;
    dropoff: Point;
    pickupAddress: string;
    dropoffAddress: string;
    passengerCount?: number;
    rideClass?: RideClass;
  }) => api.post('/rides/request', data),
  active: () => api.get('/rides/active'),
  get: (id: string) => api.get(`/rides/${id}`),
  cancel: (id: string, reason?: string) => api.post(`/rides/${id}/cancel`, { reason }),
  sos: (id: string, coords?: { lat: number; lng: number }) =>
    api.post(`/rides/${id}/sos`, coords ? { lat: coords.lat, lng: coords.lng } : {}),
};

// Places (mounted at /api/v1/places) — "Where to?" search behind the server-side
// provider seam; the Google key never reaches the client.
export interface PlaceSuggestion {
  placeId: string;
  primary: string;
  secondary?: string;
}
export interface PlaceDetail {
  placeId: string;
  label: string;
  lat: number;
  lng: number;
}
export const placesApi = {
  autocomplete: (q: string, near?: Point) =>
    api.get('/places/autocomplete', { params: { q, ...(near ? { lat: near.lat, lng: near.lng } : {}) } }),
  details: (placeId: string) => api.get('/places/details', { params: { placeId } }),
};

// Courier (mounted at /api/v1/courier)
type CourierSize = 'SMALL' | 'MEDIUM' | 'LARGE' | 'EXTRA_LARGE';
type CourierSpeed = 'STANDARD' | 'EXPRESS' | 'RUSH';
export const courierApi = {
  estimate: (data: { pickup: Point; dropoff: Point; packageSize: CourierSize; speed: CourierSpeed }) =>
    api.post('/courier/estimate', data),
  order: (data: {
    pickup: Point;
    dropoff: Point;
    pickupAddress: string;
    dropoffAddress: string;
    packageSize: CourierSize;
    packageDescription?: string;
    speed: CourierSpeed;
    recipientName: string;
    recipientPhone: string;
    payer?: 'SENDER' | 'RECIPIENT';
  }) => api.post('/courier/order', data),
  orders: () => api.get('/courier/orders'),
  get: (id: string) => api.get(`/courier/order/${id}`),
  cancel: (id: string, reason?: string) => api.post(`/courier/order/${id}/cancel`, { reason }),
  // Proof of delivery (D8-02): upload the photo → get a url → confirm handoff.
  uploadProof: (id: string, form: FormData, session?: AuthSessionSnapshot) =>
    api.post(`/courier/order/${id}/proof-photo`, form, capturedAuthConfig(session, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })),
  proof: (id: string, proofPhotoUrl: string, session?: AuthSessionSnapshot) =>
    api.post(`/courier/order/${id}/proof`, { proofPhotoUrl }, capturedAuthConfig(session)),
};

// Services (mounted at /api/v1/services)
export const servicesApi = {
  providers: (trade: string) => api.get('/services/providers', { params: { trade } }),
  providerMe: (session?: AuthSessionSnapshot) =>
    api.get('/services/providers/me', capturedAuthConfig(session)),
  saveProvider: (
    data: { trade: string; bio?: string; portfolioPhotos?: string[] },
    session?: AuthSessionSnapshot,
  ) => api.post('/services/providers', data, capturedAuthConfig(session)),
  addQualification: (
    data: {
      type: 'GEI_LICENCE' | 'CVQ' | 'GTEE' | 'CITY_AND_GUILDS' | 'OTHER';
      referenceNumber?: string;
    },
    session?: AuthSessionSnapshot,
  ) => api.post('/services/providers/qualifications', data, capturedAuthConfig(session)),
  requestJob: (data: { providerId: string; description: string; photos?: string[] }) =>
    api.post('/services/jobs', data),
  jobs: () => api.get('/services/jobs'),
  job: (id: string) => api.get(`/services/jobs/${id}`),
  // Customer accepts the provider's quote by scheduling the job.
  scheduleJob: (id: string, scheduledFor: string) => api.post(`/services/jobs/${id}/schedule`, { scheduledFor }),
  cancelJob: (id: string) => api.post(`/services/jobs/${id}/cancel`, {}),
  rateJob: (id: string, score: number, comment?: string) => api.post(`/services/jobs/${id}/rate`, { score, comment }),
  // Provider side: send the quote, then accept/decline the customer's slot (§4.3),
  // then close the job out when the work is done (SWIFT-AUD-D8-04: the complete
  // endpoint existed server-side but was never wired, so a ServiceJob stalled
  // forever at SCHEDULED — no completion, no rating, no reputation).
  quoteJob: (id: string, amount: number) => api.post(`/services/jobs/${id}/quote`, { amount }),
  confirmJob: (id: string) => api.post(`/services/jobs/${id}/confirm`, {}),
  declineSlot: (id: string) => api.post(`/services/jobs/${id}/decline-slot`, {}),
  completeJob: (id: string) => api.post(`/services/jobs/${id}/complete`, {}),
};

// Verification (mounted at /api/v1/verification)
export const verificationApi = {
  status: (role: string, vehicleType?: string) =>
    api.get('/verification/status', { params: { role, ...(vehicleType ? { vehicleType } : {}) } }),
  upload: (form: FormData, session?: AuthSessionSnapshot) =>
    api.post('/verification/upload', form, capturedAuthConfig(session, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })),
  submitDocument: (data: {
    role: string;
    docType: string;
    fileUrl: string;
    consent: true;
    privacyNoticeVersion: string;
  }, session?: AuthSessionSnapshot) =>
    api.post('/verification/documents', data, capturedAuthConfig(session)),
  submitIdentity: (
    data: { idDocumentUrl: string; selfieUrl: string; consent: true; privacyNoticeVersion: string },
    session?: AuthSessionSnapshot,
  ) => api.post('/verification/identity', data, capturedAuthConfig(session)),
};

// The mover vehicle taxonomy — mirrors the server's VehicleType enum
// (config/vehicle-classes). Kept in one place so the picker, the hook and the
// API client never drift.
export type VehicleKind =
  | 'BICYCLE'
  | 'MOTORCYCLE'
  | 'CAR'
  | 'WAGON_CAR'
  | 'BUS_9'
  | 'BUS_15'
  | 'CANTER_SHORT'
  | 'CANTER_LONG'
  | 'BOX_TRUCK_SHORT'
  | 'BOX_TRUCK_LONG';

/** Passenger-capable vehicles register as taxi Drivers (they need vehicle
 *  make/plate details) — mirrors the server taxonomy's vehicles that carry a
 *  ride class. The rest are delivery Riders. */
export const DRIVER_VEHICLE_KINDS: VehicleKind[] = ['CAR', 'WAGON_CAR', 'BUS_9', 'BUS_15'];

// Partner provisioning (mounted at /api/v1/partner)
export const partnerApi = {
  become: (data: {
    role: 'MOVER' | 'VENDOR';
    vehicleType?: VehicleKind;
    vehicle?: { make: string; model: string; year: number; color: string; licensePlate: string };
    business?: {
      name: string;
      vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
      phone: string;
      addressLine1: string;
      city: string;
      region?: string;
      latitude: number;
      longitude: number;
    };
  }, session?: AuthSessionSnapshot) =>
    api.post('/partner/become', data, capturedAuthConfig(session)),
};

// Mover ops — Rider (delivery/courier), mounted at /api/v1/rider
export const riderApi = {
  profile: () => api.get('/rider/profile'),
  standing: () => api.get('/rider/standing'),
  currentOffer: () => api.get('/rider/offers/current'),
  offerSeen: (orderId: string, offerAttemptId?: string) => api.post('/rider/offers/seen', { orderId, ...(offerAttemptId ? { offerAttemptId } : {}) }),
  goOnline: (latitude: number, longitude: number, session?: AuthSessionSnapshot) =>
    api.post('/rider/go-online', { latitude, longitude }, capturedAuthConfig(session)),
  goOffline: () => api.post('/rider/go-offline'),
  location: (latitude: number, longitude: number, session?: AuthSessionSnapshot) =>
    api.put('/rider/location', { latitude, longitude }, capturedAuthConfig(session)),
  available: () => api.get('/rider/orders/available'),
  active: () => api.get('/rider/orders/active'),
  accept: (id: string, fare?: number) => api.post(`/rider/orders/${id}/accept`, { fare }),
  // Accepting a dispatch OFFER (the offer card) vs grabbing from the open board:
  // this path acks the offer so it's never scored as a timeout [SWIFT-016].
  acceptOffer: (orderId: string, fare?: number, offerAttemptId?: string) => api.post('/rider/offers/accept', { orderId, fare, ...(offerAttemptId ? { offerAttemptId } : {}) }),
  declineOffer: (orderId: string, offerAttemptId?: string) => api.post('/rider/offers/decline', { orderId, ...(offerAttemptId ? { offerAttemptId } : {}) }),
  // Golden-rule handover: GPS is mandatory server-side (claims are impossible
  // without it) — an empty body 400s.
  handover: (
    id: string,
    body: { outcome: 'paid' | 'no_show' | 'refused'; gps: { lat: number; lng: number }; photoUrl?: string },
    session?: AuthSessionSnapshot,
  ) => api.post(`/rider/orders/${id}/handover`, body, capturedAuthConfig(session)),
  // Intermediate delivery-leg transitions. The state machine walks
  // RIDER_ASSIGNED → en-route-pickup → arrived-pickup → picked-up →
  // en-route-delivery → arrived → handover/delivered. Without these the rider
  // can never reach ARRIVED, so handover/delivered always 4xx.
  enRoutePickup: (id: string) => api.put(`/rider/orders/${id}/en-route-pickup`),
  arrivedPickup: (id: string) => api.put(`/rider/orders/${id}/arrived-pickup`),
  pickedUp: (id: string) => api.put(`/rider/orders/${id}/picked-up`),
  enRouteDelivery: (id: string) => api.put(`/rider/orders/${id}/en-route-delivery`),
  arrivedAtCustomer: (id: string) => api.put(`/rider/orders/${id}/arrived`),
  delivered: (id: string) => api.put(`/rider/orders/${id}/delivered`),
  earningsToday: () => api.get('/rider/earnings/today'),
  earningsSummary: () => api.get('/rider/earnings/summary'),
  earnings: (params?: Record<string, string | number>) => api.get('/rider/earnings', { params }),
  earningsDaily: (days = 7) => api.get('/rider/earnings/daily', { params: { days } }),
  earningsStatement: (session?: AuthSessionSnapshot) =>
    api.get('/rider/earnings/statement', capturedAuthConfig(session, { params: { link: 1 } })),
  demand: (p: Point) => api.get(`/rider/demand?lat=${p.lat}&lng=${p.lng}`),
  // MMG cash ledger — delivery fees stores owe me (customer paid the store)
  cashSettlements: () => api.get('/rider/cash-settlements'),
  confirmCashSettlement: (id: string) => api.post(`/rider/cash-settlements/${id}/confirm`, {}),
  history: (params?: { page?: number; limit?: number }) => api.get('/rider/orders', { params }),
  stats: () => api.get('/rider/stats'),
  subscription: () => api.get('/rider/subscription'),
  uploadVehiclePhoto: (form: FormData, session?: AuthSessionSnapshot) =>
    api.post('/rider/vehicle-photo', form, capturedAuthConfig(session, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })),
};

// Mover ops — Driver (taxi), mounted at /api/v1/driver
export const driverApi = {
  profile: () => api.get('/driver/profile'),
  standing: () => api.get('/driver/standing'),
  currentOffer: () => api.get('/driver/offers/current'),
  offerSeen: (orderId: string, offerAttemptId?: string) => api.post('/driver/offers/seen', { orderId, ...(offerAttemptId ? { offerAttemptId } : {}) }),
  updateProfile: (data: { mmgPayUrl?: string | null }) => api.put('/driver/profile', data),
  goOnline: (latitude: number, longitude: number, session?: AuthSessionSnapshot) =>
    api.post('/driver/go-online', { latitude, longitude }, capturedAuthConfig(session)),
  goOffline: () => api.post('/driver/go-offline'),
  location: (latitude: number, longitude: number, session?: AuthSessionSnapshot) =>
    api.put('/driver/location', { latitude, longitude }, capturedAuthConfig(session)),
  available: () => api.get('/driver/rides/available'),
  active: () => api.get('/driver/rides/active'),
  accept: (id: string, fare?: number) => api.post(`/driver/rides/${id}/accept`, { fare }),
  // Offer-card accept (acks the offer, no timeout penalty) vs board-grab [SWIFT-016].
  acceptOffer: (orderId: string, fare?: number, offerAttemptId?: string) => api.post('/driver/offers/accept', { orderId, fare, ...(offerAttemptId ? { offerAttemptId } : {}) }),
  declineOffer: (orderId: string, offerAttemptId?: string) => api.post('/driver/offers/decline', { orderId, ...(offerAttemptId ? { offerAttemptId } : {}) }),
  enRoute: (id: string) => api.put(`/driver/rides/${id}/en-route`),
  arrived: (id: string) => api.put(`/driver/rides/${id}/arrived`),
  verifyPin: (id: string, pin: string) => api.put(`/driver/rides/${id}/verify-pin`, { pin }),
  start: (id: string) => api.put(`/driver/rides/${id}/start`),
  complete: (id: string) => api.put(`/driver/rides/${id}/complete`),
  earningsToday: () => api.get('/driver/earnings/today'),
  earningsSummary: () => api.get('/driver/earnings/summary'),
  earnings: (params?: Record<string, string | number>) => api.get('/driver/earnings', { params }),
  earningsDaily: (days = 7) => api.get('/driver/earnings/daily', { params: { days } }),
  earningsStatement: (session?: AuthSessionSnapshot) =>
    api.get('/driver/earnings/statement', capturedAuthConfig(session, { params: { link: 1 } })),
  demand: (p: Point) => api.get(`/driver/demand?lat=${p.lat}&lng=${p.lng}`),
  rides: (params?: { page?: number; limit?: number; status?: string }) => api.get('/driver/rides', { params }),
  rateCustomer: (id: string, score: number, comment?: string) =>
    api.post(`/driver/rides/${id}/rate-customer`, { score, ...(comment ? { comment } : {}) }),
  subscription: () => api.get('/driver/subscription'),
  uploadVehiclePhoto: (form: FormData, session?: AuthSessionSnapshot) =>
    api.post('/driver/vehicle-photo', form, capturedAuthConfig(session, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })),
};

// Vendor ops (mounted at /api/v1/vendor)
export interface VendorItemInput {
  categoryId: string;
  name: string;
  description?: string;
  basePrice: number;
  isAvailable?: boolean;
  isPopular?: boolean;
  sku?: string;
  unit?: string;
  stockQuantity?: number;
  imageUrl?: string;
}

export const vendorApi = {
  profile: () => api.get('/vendor/profile'),
  toggleOpen: () => api.put('/vendor/vendor/toggle-open'),
  toggleOrders: () => api.put('/vendor/vendor/toggle-orders'),
  orders: (params?: { status?: string; search?: string; page?: number; limit?: number }) =>
    api.get('/vendor/orders', { params }),
  order: (id: string) => api.get(`/vendor/orders/${id}`),
  acceptOrder: (id: string) => api.put(`/vendor/orders/${id}/accept`),
  confirmPayment: (id: string) => api.post(`/vendor/orders/${id}/confirm-payment`, {}),
  // Grocery picking (§5.3)
  setLinePicked: (orderId: string, lineId: string, picked: boolean) =>
    api.put(`/vendor/orders/${orderId}/items/${lineId}/picked`, { picked }),
  proposeSubstitution: (orderId: string, lineId: string, substituteItemId: string) =>
    api.post(`/vendor/orders/${orderId}/items/${lineId}/substitute`, { substituteItemId }),
  refundLine: (orderId: string, lineId: string) =>
    api.post(`/vendor/orders/${orderId}/items/${lineId}/refund-line`, {}),
  adjustStock: (itemId: string, body: { delta: number; reason: string; note?: string }) =>
    api.post(`/vendor/items/${itemId}/adjust`, body),
  lowStock: () => api.get('/vendor/items/low-stock'),
  // MMG cash ledger — delivery fees this store owes riders
  cashSettlements: () => api.get('/vendor/cash-settlements'),
  confirmCashSettlement: (id: string) => api.post(`/vendor/cash-settlements/${id}/confirm`, {}),
  preparing: (id: string) => api.put(`/vendor/orders/${id}/preparing`),
  ready: (id: string) => api.put(`/vendor/orders/${id}/ready`),
  completePickup: (id: string, code?: string) => api.put(`/vendor/orders/${id}/complete-pickup`, { code }),
  completeAppointment: (id: string) => api.put(`/vendor/orders/${id}/complete-appointment`),
  reject: (id: string) => api.put(`/vendor/orders/${id}/reject`),
  retryDispatch: (id: string) => api.post(`/vendor/orders/${id}/retry-dispatch`),
  items: () => api.get('/vendor/items'),
  subscription: () => api.get('/vendor/subscription'),
  // Menu management
  categories: () => api.get('/vendor/categories'),
  createCategory: (data: { name: string; description?: string }) => api.post('/vendor/categories', data),
  updateCategory: (id: string, data: { name?: string; description?: string }) => api.put(`/vendor/categories/${id}`, data),
  deleteCategory: (id: string) => api.delete(`/vendor/categories/${id}`),
  createItem: (
    data: VendorItemInput,
    session?: AuthSessionSnapshot,
    storeId?: string | null,
  ) => api.post('/vendor/items', data, capturedVendorAuthConfig(session, storeId)),
  updateItem: (
    id: string,
    data: Partial<VendorItemInput>,
    session?: AuthSessionSnapshot,
    storeId?: string | null,
  ) => api.put(`/vendor/items/${id}`, data, capturedVendorAuthConfig(session, storeId)),
  deleteItem: (id: string) => api.delete(`/vendor/items/${id}`),
  setItemAvailability: (id: string, isAvailable: boolean) =>
    api.put(`/vendor/items/${id}/availability`, { isAvailable }),
  uploadItemImage: (
    id: string,
    form: FormData,
    session?: AuthSessionSnapshot,
    storeId?: string | null,
  ) => api.post(`/vendor/items/${id}/image`, form, capturedVendorAuthConfig(session, storeId, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })),
  // Modifiers (option groups + options on an item)
  addOptionGroup: (
    itemId: string,
    data: { name: string; isRequired?: boolean; minSelect?: number; maxSelect?: number },
    session?: AuthSessionSnapshot,
  ) => api.post(`/vendor/items/${itemId}/option-groups`, data, capturedAuthConfig(session)),
  updateOptionGroup: (id: string, data: { name?: string; isRequired?: boolean; minSelect?: number; maxSelect?: number }) =>
    api.put(`/vendor/option-groups/${id}`, data),
  deleteOptionGroup: (id: string, session?: AuthSessionSnapshot) =>
    api.delete(`/vendor/option-groups/${id}`, capturedAuthConfig(session)),
  addOption: (
    groupId: string,
    data: { name: string; additionalPrice?: number; isDefault?: boolean },
    session?: AuthSessionSnapshot,
  ) => api.post(`/vendor/option-groups/${groupId}/options`, data, capturedAuthConfig(session)),
  updateOption: (id: string, data: { name?: string; additionalPrice?: number; isDefault?: boolean }) =>
    api.put(`/vendor/options/${id}`, data),
  deleteOption: (id: string, session?: AuthSessionSnapshot) =>
    api.delete(`/vendor/options/${id}`, capturedAuthConfig(session)),
  // Insights / settings
  analytics: () => api.get('/vendor/analytics/overview'),
  analyticsRevenue: (days = 14) => api.get('/vendor/analytics/revenue', { params: { days } }),
  analyticsOps: (days = 30) => api.get('/vendor/analytics/ops', { params: { days } }),
  analyticsPopularItems: (limit = 8) => api.get('/vendor/analytics/popular-items', { params: { limit } }),
  analyticsBusyHours: () => api.get('/vendor/analytics/busy-hours'),
  analyticsRepeatCustomers: () => api.get('/vendor/analytics/repeat-customers'),
  salesStatement: (session?: AuthSessionSnapshot) =>
    api.get('/vendor/sales-statement', capturedAuthConfig(session, { params: { link: 1 } })),
  hours: () => api.get('/vendor/hours'),
  bookings: (params?: { from?: string; to?: string }) => api.get('/vendor/bookings', { params }),
  // Block time (scheduling 2.1): one-off exceptions — full day or a window.
  bookingExceptions: (params?: { from?: string; to?: string }) => api.get('/vendor/bookings/exceptions', { params }),
  createBookingException: (data: { date: string; start?: string; end?: string; reason?: string; itemId?: string }) =>
    api.post('/vendor/bookings/exceptions', data),
  deleteBookingException: (id: string) => api.delete(`/vendor/bookings/exceptions/${id}`),
  setHours: (hours: { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }[]) =>
    api.put('/vendor/hours', { hours }),
  updateProfile: (data: { name?: string; phone?: string; description?: string; mmgPayUrl?: string | null; selfDeliveryEnabled?: boolean }) =>
    api.put('/vendor/profile', data),
  importItems: (
    csv: string,
    session?: AuthSessionSnapshot,
    storeId?: string | null,
  ) => api.post('/vendor/items/import', { csv }, capturedVendorAuthConfig(session, storeId)),
  importTemplate: () => api.get('/vendor/items/import/template'),
  importAutomap: (
    csv: string,
    session?: AuthSessionSnapshot,
    storeId?: string | null,
  ) => api.post('/vendor/items/import/automap', { csv }, capturedVendorAuthConfig(session, storeId)),
  importXlsx: (
    form: FormData,
    session?: AuthSessionSnapshot,
    storeId?: string | null,
  ) => api.post('/vendor/items/import/xlsx', form, capturedVendorAuthConfig(session, storeId, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })),
  importMenuPdf: (
    form: FormData,
    session?: AuthSessionSnapshot,
    storeId?: string | null,
  ) => api.post('/vendor/items/import/menu-parse', form, capturedVendorAuthConfig(session, storeId, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })),
  // Storefront QR (manager+) — short link + printable SVG code + lifecycle
  qr: () => api.get('/vendor/qr'),
  qrAnalytics: (range: '7d' | '30d' | '90d' | 'all') => api.get(`/vendor/qr/analytics?range=${range}`),
  qrRegenerate: () => api.post('/vendor/qr/regenerate', {}),
  qrDeactivate: () => api.post('/vendor/qr/deactivate', { confirm: true }),
  // Reviews (manager+ can respond)
  reviews: () => api.get('/vendor/reviews'),
  respondReview: (id: string, response: string) => api.post(`/vendor/reviews/${id}/respond`, { response }),
  // Movement R9 — Standing module + item-thumbs Pareto
  standing: () => api.get('/vendor/standing'),
  itemFeedback: () => api.get('/vendor/analytics/item-feedback'),
  // Promotions (manager+)
  promos: () => api.get('/vendor/promos'),
  createPromo: (data: {
    code: string; description: string; discountType: 'PERCENTAGE' | 'FIXED_AMOUNT';
    discountValue: number; minOrderAmount?: number; validUntil: string; maxUses?: number;
  }) => api.post('/vendor/promos', data),
  updatePromo: (id: string, data: { isActive?: boolean; validUntil?: string }) =>
    api.put(`/vendor/promos/${id}`, data),
  deletePromo: (id: string) => api.delete(`/vendor/promos/${id}`),
  // Staff & roles (owner-only)
  staff: () => api.get('/vendor/staff'),
  addStaff: (data: { phone: string; role: 'MANAGER' | 'STAFF' }) => api.post('/vendor/staff', data),
  updateStaff: (id: string, role: 'MANAGER' | 'STAFF') => api.put(`/vendor/staff/${id}`, { role }),
  removeStaff: (id: string) => api.delete(`/vendor/staff/${id}`),
};

// Chat (mounted at /api/v1/chat) — order-scoped rider/customer messaging
export const chatApi = {
  room: (orderId: string) => api.post('/chat/rooms', { orderId }),
  messages: (roomId: string) => api.get(`/chat/rooms/${roomId}/messages`),
  send: (roomId: string, message: string) => api.post(`/chat/rooms/${roomId}/messages`, { message }),
};

// Swift Ads (mounted at /api/v1/ads) — the advertiser dashboard surface
// (ads-platform spec §14). Serving/events ride lib/ads.ts, not this block.
export const adsApi = {
  register: (data: {
    companyName: string; industry: string; contactName: string; contactEmail: string;
    contactPhone: string; website?: string; city?: string;
  }) => api.post('/ads/advertiser/register', data),
  me: () => api.get('/ads/advertiser/me'),
  campaigns: (advertiserId: string) => api.get(`/ads/advertiser/${advertiserId}/campaigns`),
  invoices: (advertiserId: string) => api.get(`/ads/advertiser/${advertiserId}/invoices`),
  members: (advertiserId: string) => api.get(`/ads/advertiser/${advertiserId}/members`),
  addMember: (advertiserId: string, data: { phone: string; role: 'MANAGER' | 'ANALYST' }) =>
    api.post(`/ads/advertiser/${advertiserId}/members`, data),
  placements: () => api.get('/ads/placements'),
  availability: (placementId: string, params: { city: string; from: string; to: string }) =>
    api.get(`/ads/placements/${placementId}/availability`, { params }),
  createCampaign: (data: {
    advertiserId: string; placementId: string; name: string; cities: string[];
    startWeek: string; endWeek: string; objective?: string;
    destinationType?: 'NONE' | 'URL' | 'DEEPLINK'; destinationValue?: string;
  }, session?: AuthSessionSnapshot) =>
    api.post('/ads/campaigns', data, capturedAuthConfig(session)),
  reserve: (campaignId: string, session?: AuthSessionSnapshot) =>
    api.post(`/ads/campaigns/${campaignId}/reserve`, {}, capturedAuthConfig(session)),
  checkout: (
    campaignId: string,
    provider: 'MOCK' | 'MMG' | 'POWERTRANZ' | 'MANUAL' = 'MANUAL',
    session?: AuthSessionSnapshot,
  ) => api.post(`/ads/campaigns/${campaignId}/checkout`, { provider }, capturedAuthConfig(session)),
  uploadCreative: (campaignId: string, form: FormData, session?: AuthSessionSnapshot) =>
    api.post(`/ads/campaigns/${campaignId}/creatives`, form, capturedAuthConfig(session, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })),
  stats: (campaignId: string) => api.get(`/ads/campaigns/${campaignId}/stats`),
  refundPreview: (campaignId: string, session?: AuthSessionSnapshot) =>
    api.get(`/ads/campaigns/${campaignId}/refund-preview`, capturedAuthConfig(session)),
  pause: (campaignId: string) => api.post(`/ads/campaigns/${campaignId}/pause`, {}),
  resume: (campaignId: string) => api.post(`/ads/campaigns/${campaignId}/resume`, {}),
  cancel: (campaignId: string, session?: AuthSessionSnapshot) =>
    api.post(`/ads/campaigns/${campaignId}/cancel`, {}, capturedAuthConfig(session)),
};
