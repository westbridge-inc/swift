import axios from 'axios';
import { useAuthStore } from '../stores/authStore';

// eslint-disable-next-line no-undef
const API_URL = __DEV__ ? 'http://localhost:3000' : 'https://api.swift.gy';

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
  register: (data: { phone: string; firstName: string; lastName: string; email?: string }) =>
    api.post('/auth/register', data),
  refresh: (refreshToken: string) => api.post('/auth/refresh', { refreshToken }),
  logout: () => api.post('/auth/logout'),
};

// Customer
export const customerApi = {
  getProfile: () => api.get('/customer/profile'),
  updateProfile: (data: { firstName?: string; lastName?: string }) => api.put('/customer/profile', data),
  getAddresses: () => api.get('/customer/addresses'),
  addAddress: (data: any) => api.post('/customer/addresses', data),
  getHome: (lat?: number, lng?: number) => api.get('/customer/home', { params: { lat, lng } }),
  getVendors: (params?: Record<string, string>) => api.get('/customer/vendors', { params }),
  getVendor: (id: string) => api.get(`/customer/vendors/${id}`),
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
  }) => api.post('/customer/checkout', data),
  getNotifications: () => api.get('/customer/notifications'),
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
