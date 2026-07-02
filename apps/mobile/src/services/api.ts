import axios from 'axios';
import { useAuthStore } from '../stores/authStore';
import { useStoreSwitcher } from '../stores/storeSwitcher';

// Build-time override (set per EAS build profile, e.g. preview→staging,
// production→prod). Falls back to localhost in dev and the prod domain otherwise.
// eslint-disable-next-line no-undef
export const API_URL = process.env['EXPO_PUBLIC_API_URL'] ?? (__DEV__ ? 'http://localhost:3000' : 'https://api.swift.gy');

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// Request interceptor to attach auth token
api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Multi-store switch — scope vendor requests to the selected store.
  const storeId = useStoreSwitcher.getState().selectedStoreId;
  if (storeId) {
    config.headers['x-vendor-id'] = storeId;
  }
  return config;
});

// Response interceptor for token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const refreshToken = useAuthStore.getState().refreshToken;
      if (refreshToken) {
        try {
          const { data } = await axios.post(`${API_URL}/api/v1/auth/refresh`, { refreshToken });
          useAuthStore.getState().setAuth(
            useAuthStore.getState().user!,
            data.data.accessToken,
            data.data.refreshToken,
          );
          originalRequest.headers.Authorization = `Bearer ${data.data.accessToken}`;
          return api(originalRequest);
        } catch {
          useAuthStore.getState().logout();
        }
      }
    }
    return Promise.reject(error);
  },
);

// Auth
export const authApi = {
  sendOtp: (phone: string) => api.post('/auth/send-otp', { phone }),
  verifyOtp: (phone: string, code: string) => api.post('/auth/verify-otp', { phone, code }),
  countries: () => api.get('/auth/countries'),
  register: (data: {
    phone: string;
    firstName: string;
    lastName: string;
    email?: string;
    role?: 'CUSTOMER' | 'MOVER' | 'VENDOR';
    countryCode?: string;
  }) => api.post('/auth/register', data),
  refresh: (refreshToken: string) => api.post('/auth/refresh', { refreshToken }),
  logout: () => api.post('/auth/logout'),
  // Mandatory signup selfie — multipart camera capture; becomes the public photo.
  uploadSelfie: (form: FormData) =>
    api.post('/auth/selfie', form, { headers: { 'Content-Type': 'multipart/form-data' } }),
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

export const customerApi = {
  getProfile: () => api.get('/customer/profile'),
  updateProfile: (data: { firstName?: string; lastName?: string }) => api.put('/customer/profile', data),
  switchRole: (role: string) => api.post('/customer/switch-role', { role }),
  // Redeem a referral code (writes referredBy). `token` lets a just-registered
  // user redeem before the auth store has propagated.
  redeemReferral: (code: string, token?: string) =>
    api.post('/customer/referral/redeem', { code }, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined),
  getAddresses: () => api.get('/customer/addresses'),
  addAddress: (data: AddressInput) => api.post('/customer/addresses', data),
  getHome: (lat?: number, lng?: number) => api.get('/customer/home', { params: { lat, lng } }),
  getVendors: (params?: Record<string, string>) => api.get('/customer/vendors', { params }),
  getVendor: (id: string) => api.get(`/customer/vendors/${id}`),
  getVendorReviews: (id: string) => api.get(`/customer/vendors/${id}/reviews`),
  getItemSlots: (itemId: string, date: string) => api.get(`/customer/items/${itemId}/slots`, { params: { date } }),
  getFavorites: () => api.get('/customer/favorites'),
  addFavorite: (vendorId: string) => api.post(`/customer/favorites/${vendorId}`, {}),
  removeFavorite: (vendorId: string) => api.delete(`/customer/favorites/${vendorId}`),
  getOrders: () => api.get('/customer/orders'),
  getOrder: (id: string) => api.get(`/customer/orders/${id}`),
  // Order placement = checkout; it reads the server-side cart. (The old POST
  // /customer/orders had no backend route.)
  placeOrder: (data: {
    paymentMethod?: string;
    deliveryInstructions?: string;
    tipAmount?: number;
    scheduledFor?: string;
    promoCode?: string;
    fulfillmentSelections?: Record<string, 'DELIVERY' | 'PICKUP'>;
  }) => api.post('/customer/checkout', data),
  getNotifications: () => api.get('/customer/notifications'),
  reorder: (id: string) => api.post(`/customer/orders/${id}/reorder`, {}),
  rateOrder: (
    id: string,
    body: { vendorScore?: number; vendorComment?: string; riderScore?: number; riderComment?: string },
  ) => api.post(`/customer/orders/${id}/rate`, body),
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
export type RideClass = 'ECONOMY' | 'COMFORT' | 'XL';
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
export const rideApi = {
  estimate: (pickup: Point, dropoff: Point) => api.post('/rides/estimate', { pickup, dropoff }),
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
};

// Services (mounted at /api/v1/services)
export const servicesApi = {
  providers: (trade: string) => api.get('/services/providers', { params: { trade } }),
  requestJob: (data: { providerId: string; description: string; photos?: string[] }) =>
    api.post('/services/jobs', data),
  jobs: () => api.get('/services/jobs'),
  job: (id: string) => api.get(`/services/jobs/${id}`),
};

// Verification (mounted at /api/v1/verification)
export const verificationApi = {
  status: (role: string, vehicleType?: string) =>
    api.get('/verification/status', { params: { role, ...(vehicleType ? { vehicleType } : {}) } }),
  upload: (form: FormData) =>
    api.post('/verification/upload', form, { headers: { 'Content-Type': 'multipart/form-data' } }),
  submitDocument: (data: {
    role: string;
    docType: string;
    fileUrl: string;
    consent: true;
    privacyNoticeVersion: string;
  }) => api.post('/verification/documents', data),
  submitIdentity: (data: { idDocumentUrl: string; selfieUrl: string; consent: true; privacyNoticeVersion: string }) =>
    api.post('/verification/identity', data),
};

// Partner provisioning (mounted at /api/v1/partner)
export const partnerApi = {
  become: (data: {
    role: 'MOVER' | 'VENDOR';
    vehicleType?: 'BICYCLE' | 'MOTORCYCLE' | 'CAR';
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
  }) => api.post('/partner/become', data),
};

// Mover ops — Rider (delivery/courier), mounted at /api/v1/rider
export const riderApi = {
  profile: () => api.get('/rider/profile'),
  goOnline: () => api.post('/rider/go-online'),
  goOffline: () => api.post('/rider/go-offline'),
  location: (latitude: number, longitude: number) => api.put('/rider/location', { latitude, longitude }),
  available: () => api.get('/rider/orders/available'),
  active: () => api.get('/rider/orders/active'),
  accept: (id: string, fare?: number) => api.post(`/rider/orders/${id}/accept`, { fare }),
  handover: (id: string) => api.post(`/rider/orders/${id}/handover`),
  delivered: (id: string) => api.put(`/rider/orders/${id}/delivered`),
  earningsToday: () => api.get('/rider/earnings/today'),
  earningsSummary: () => api.get('/rider/earnings/summary'),
  earnings: () => api.get('/rider/earnings'),
};

// Mover ops — Driver (taxi), mounted at /api/v1/driver
export const driverApi = {
  profile: () => api.get('/driver/profile'),
  goOnline: () => api.post('/driver/go-online'),
  goOffline: () => api.post('/driver/go-offline'),
  location: (latitude: number, longitude: number) => api.put('/driver/location', { latitude, longitude }),
  available: () => api.get('/driver/rides/available'),
  active: () => api.get('/driver/rides/active'),
  accept: (id: string, fare?: number) => api.post(`/driver/rides/${id}/accept`, { fare }),
  enRoute: (id: string) => api.put(`/driver/rides/${id}/en-route`),
  arrived: (id: string) => api.put(`/driver/rides/${id}/arrived`),
  verifyPin: (id: string, pin: string) => api.put(`/driver/rides/${id}/verify-pin`, { pin }),
  start: (id: string) => api.put(`/driver/rides/${id}/start`),
  complete: (id: string) => api.put(`/driver/rides/${id}/complete`),
  earningsToday: () => api.get('/driver/earnings/today'),
  earningsSummary: () => api.get('/driver/earnings/summary'),
  earnings: () => api.get('/driver/earnings'),
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
  orders: () => api.get('/vendor/orders'),
  acceptOrder: (id: string) => api.put(`/vendor/orders/${id}/accept`),
  preparing: (id: string) => api.put(`/vendor/orders/${id}/preparing`),
  ready: (id: string) => api.put(`/vendor/orders/${id}/ready`),
  completePickup: (id: string, code?: string) => api.put(`/vendor/orders/${id}/complete-pickup`, { code }),
  completeAppointment: (id: string) => api.put(`/vendor/orders/${id}/complete-appointment`),
  reject: (id: string) => api.put(`/vendor/orders/${id}/reject`),
  items: () => api.get('/vendor/items'),
  subscription: () => api.get('/vendor/subscription'),
  // Menu management
  categories: () => api.get('/vendor/categories'),
  createCategory: (data: { name: string; description?: string }) => api.post('/vendor/categories', data),
  createItem: (data: VendorItemInput) => api.post('/vendor/items', data),
  updateItem: (id: string, data: Partial<VendorItemInput>) => api.put(`/vendor/items/${id}`, data),
  deleteItem: (id: string) => api.delete(`/vendor/items/${id}`),
  setItemAvailability: (id: string, isAvailable: boolean) =>
    api.put(`/vendor/items/${id}/availability`, { isAvailable }),
  uploadItemImage: (id: string, form: FormData) =>
    api.post(`/vendor/items/${id}/image`, form, { headers: { 'Content-Type': 'multipart/form-data' } }),
  // Modifiers (option groups + options on an item)
  addOptionGroup: (itemId: string, data: { name: string; isRequired?: boolean; minSelect?: number; maxSelect?: number }) =>
    api.post(`/vendor/items/${itemId}/option-groups`, data),
  updateOptionGroup: (id: string, data: { name?: string; isRequired?: boolean; minSelect?: number; maxSelect?: number }) =>
    api.put(`/vendor/option-groups/${id}`, data),
  deleteOptionGroup: (id: string) => api.delete(`/vendor/option-groups/${id}`),
  addOption: (groupId: string, data: { name: string; additionalPrice?: number; isDefault?: boolean }) =>
    api.post(`/vendor/option-groups/${groupId}/options`, data),
  updateOption: (id: string, data: { name?: string; additionalPrice?: number; isDefault?: boolean }) =>
    api.put(`/vendor/options/${id}`, data),
  deleteOption: (id: string) => api.delete(`/vendor/options/${id}`),
  // Insights / settings
  analytics: () => api.get('/vendor/analytics/overview'),
  analyticsRevenue: (days = 14) => api.get('/vendor/analytics/revenue', { params: { days } }),
  analyticsPopularItems: (limit = 8) => api.get('/vendor/analytics/popular-items', { params: { limit } }),
  hours: () => api.get('/vendor/hours'),
  setHours: (hours: { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }[]) =>
    api.put('/vendor/hours', { hours }),
  updateProfile: (data: { name?: string; phone?: string; description?: string }) =>
    api.put('/vendor/profile', data),
  importItems: (csv: string) => api.post('/vendor/items/import', { csv }),
  importTemplate: () => api.get('/vendor/items/import/template'),
  importAutomap: (csv: string) => api.post('/vendor/items/import/automap', { csv }),
};

// Chat (mounted at /api/v1/chat) — order-scoped rider/customer messaging
export const chatApi = {
  room: (orderId: string) => api.post('/chat/rooms', { orderId }),
  messages: (roomId: string) => api.get(`/chat/rooms/${roomId}/messages`),
  send: (roomId: string, message: string) => api.post(`/chat/rooms/${roomId}/messages`, { message }),
};
