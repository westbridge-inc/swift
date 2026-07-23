'use client';

// Customer ordering client for the web app — talks to the SAME backend the
// mobile app uses (/api/v1/customer/*, /api/v1/rides/*). Auth + refresh + the
// authed fetch are shared with the partner flow via apiFetch (auth.ts).
import { apiFetch, sendOtp, setTokens } from './auth';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';

export { sendOtp };

// ── Auth (customer) ────────────────────────────────────────────────────────
/** OTP login that accepts a CUSTOMER account (partner login rejects them). */
export async function verifyCustomerLogin(phone: string, code: string): Promise<{ user: any }> {
  const res = await fetch(`${API_URL}/api/v1/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'That code is not valid.');
  const data = json.data;
  if (data.isNewUser || !data.tokens?.accessToken) {
    throw new Error('No Swift account is registered to that number — sign up in the Swift app first.');
  }
  setTokens(data.tokens.accessToken, data.tokens.refreshToken);
  return { user: data.user };
}

const API_BASE = API_URL;

/** Verify the OTP without deciding a role — returns whether the number is new. */
export async function verifyOtp(phone: string, code: string): Promise<{ isNewUser: boolean; user?: any; signedIn: boolean }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/verify-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, code }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(json?.error?.message || 'That code is not valid.');
  const d = json.data;
  if (!d.isNewUser && d.tokens?.accessToken) { setTokens(d.tokens.accessToken, d.tokens.refreshToken); return { isNewUser: false, user: d.user, signedIn: true }; }
  return { isNewUser: true, signedIn: false };
}

/** Register a brand-new account with the chosen role (after OTP verify). */
export async function registerAccount(body: { phone: string; firstName: string; lastName: string; role: 'CUSTOMER' | 'VENDOR' | 'MOVER'; countryCode?: string; acceptTerms?: boolean }): Promise<{ user: any; roles: string[] }> {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ countryCode: 'GY', ...body }),
  });
  const json = await res.json().catch(() => ({}));
  const token = json?.data?.tokens?.accessToken;
  if (!res.ok || !token) throw new Error(json?.error?.message || 'Could not create your account.');
  setTokens(token, json.data.tokens.refreshToken);
  return { user: json.data.user, roles: json.data.user?.roles ?? [] };
}

/** Partner onboarding — turn a fresh account into a vendor or a mover. */
export async function becomePartner(body: any) {
  return (await apiFetch('/api/v1/partner/become', { method: 'POST', body: JSON.stringify(body) })).data;
}

// ── Types ──────────────────────────────────────────────────────────────────
export interface Vendor {
  id: string; name: string; slug: string; vendorType: string;
  logoUrl?: string | null; coverImageUrl?: string | null;
  cuisineTypes: string[]; averageRating: number; totalRatings: number;
  estimatedPrepTime: number; distanceKm?: number | null;
  isCurrentlyOpen: boolean; acceptingOrders: boolean; city?: string;
  deliveryFee?: number | string | null; etaMin?: number | null;
}
export interface MenuItem { id: string; name: string; description?: string; basePrice: number; imageUrl?: string | null; isAvailable: boolean; customerPrice?: number; fulfillment?: string; optionGroups?: OptionGroup[]; }

// ── Service appointments (SERVICE listings, fulfillment=APPOINTMENT) ─────────
export interface Appointment { itemId: string; slotStart: string; mode?: 'AT_BUSINESS' | 'MOBILE'; label?: string }
export async function getItemSlots(itemId: string, date: string): Promise<{ slots: string[]; serviceMode?: string; durationMinutes?: number }> {
  const d = (await apiFetch(`/api/v1/customer/items/${itemId}/slots?date=${date}`)).data;
  return Array.isArray(d) ? { slots: d } : d;
}
const APPT_KEY = 'swift_web_appointments';
export function getPendingAppointments(): Appointment[] {
  try { return JSON.parse(localStorage.getItem(APPT_KEY) || '[]'); } catch { return []; }
}
export function savePendingAppointment(a: Appointment) {
  const list = getPendingAppointments().filter((x) => x.itemId !== a.itemId);
  list.push(a); localStorage.setItem(APPT_KEY, JSON.stringify(list));
}
export function clearPendingAppointments() { localStorage.removeItem(APPT_KEY); }
export interface VendorDetail extends Vendor {
  description?: string;
  categories: Array<{ id: string; name: string; items: MenuItem[] }>;
}
export interface CartLine { id: string; itemId: string; name: string; quantity: number; customerPrice: number; imageUrl?: string | null; vendorId?: string; vendorName?: string; }
export interface Cart { items: CartLine[]; subtotal?: number; subtotalCustomer?: number; deliveryFee?: number; discount?: number; tipAmount?: number; totalAmount?: number; deliveryAddressId?: string | null; vendor?: { id: string; name: string } }

// ── Browse ────────────────────────────────────────────────────────────────
export async function getHome() { return (await apiFetch('/api/v1/customer/home')).data; }
export async function getVendors(type?: string): Promise<Vendor[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  return (await apiFetch(`/api/v1/customer/vendors${qs}`)).data as Vendor[];
}
export async function getVendor(id: string): Promise<VendorDetail> {
  return (await apiFetch(`/api/v1/customer/vendors/${id}`)).data as VendorDetail;
}
export async function searchVendors(q: string): Promise<Vendor[]> {
  return (await apiFetch(`/api/v1/customer/vendors?search=${encodeURIComponent(q)}`)).data as Vendor[];
}

// ── Cart ──────────────────────────────────────────────────────────────────
export async function getCart(): Promise<Cart> { return (await apiFetch('/api/v1/customer/cart')).data as Cart; }
export async function addToCart(body: { vendorId: string; itemId: string; quantity: number; selectedOptions?: Record<string, string | string[]> }) {
  return (await apiFetch('/api/v1/customer/cart/items', { method: 'POST', body: JSON.stringify(body) })).data;
}

export interface OptionGroup { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: Array<{ id: string; name: string; additionalPrice: string; isDefault: boolean; isAvailable: boolean }>; }
export async function updateCartLine(lineId: string, quantity: number) {
  return apiFetch(`/api/v1/customer/cart/items/${lineId}`, { method: 'PUT', body: JSON.stringify({ quantity }) });
}
export async function removeCartLine(lineId: string) {
  return apiFetch(`/api/v1/customer/cart/items/${lineId}`, { method: 'DELETE' });
}
export async function clearCart() { return apiFetch('/api/v1/customer/cart', { method: 'DELETE' }); }
export async function setCartAddress(addressId: string) {
  return apiFetch('/api/v1/customer/cart/address', { method: 'PUT', body: JSON.stringify({ addressId }) });
}

// ── Addresses ─────────────────────────────────────────────────────────────
export async function getAddresses(): Promise<any[]> { return (await apiFetch('/api/v1/customer/addresses')).data as any[]; }
export async function addAddress(body: { label: string; addressLine1: string; city: string; region: string; latitude: number; longitude: number; isDefault?: boolean }) {
  return (await apiFetch('/api/v1/customer/addresses', { method: 'POST', body: JSON.stringify(body) })).data;
}

// ── Checkout & orders ─────────────────────────────────────────────────────
export async function checkout(body: { paymentMethod: 'CASH' | 'MOBILE_MONEY'; tipAmount?: number; deliveryInstructions?: string; fulfillmentSelections?: Record<string, string>; promoCode?: string; appointments?: Array<{ itemId: string; slotStart: string; mode?: string }> }) {
  return (await apiFetch('/api/v1/customer/checkout', { method: 'POST', body: JSON.stringify(body) })).data;
}
export async function getOrders(): Promise<any[]> { return (await apiFetch('/api/v1/customer/orders')).data as any[]; }
export async function getOrder(id: string): Promise<any> { return (await apiFetch(`/api/v1/customer/orders/${id}`)).data; }
export async function cancelOrder(id: string, reason: string) {
  return apiFetch(`/api/v1/customer/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
}

// ── Taxi ──────────────────────────────────────────────────────────────────
export async function rideAvailability(lat: number, lng: number): Promise<{ level: 'GOOD' | 'LOW' | 'NONE'; nearestEtaMinutes?: number | null; gate?: boolean }> {
  return (await apiFetch(`/api/v1/rides/availability?lat=${lat}&lng=${lng}`)).data;
}
export async function rideEstimate(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number } }) {
  return (await apiFetch('/api/v1/rides/estimate', { method: 'POST', body: JSON.stringify(body) })).data;
}
export async function requestRide(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; pickupAddress: string; dropoffAddress: string; passengerCount?: number; rideClass?: string }) {
  return (await apiFetch('/api/v1/rides/request', { method: 'POST', body: JSON.stringify(body) })).data;
}
export async function activeRide(): Promise<any> { return (await apiFetch('/api/v1/rides/active')).data; }
export async function watchRide(body: { lat: number; lng: number }) {
  return apiFetch('/api/v1/rides/availability/watch', { method: 'POST', body: JSON.stringify(body) });
}

// ── Courier ────────────────────────────────────────────────────────────────
export async function courierEstimate(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; packageSize: string }) {
  return (await apiFetch('/api/v1/courier/estimate', { method: 'POST', body: JSON.stringify(body) })).data;
}
export async function requestCourier(body: { pickup: { lat: number; lng: number }; dropoff: { lat: number; lng: number }; pickupAddress: string; dropoffAddress: string; packageSize: string; recipientName?: string; recipientPhone?: string; notes?: string }) {
  return (await apiFetch('/api/v1/courier/order', { method: 'POST', body: JSON.stringify(body) })).data;
}

// ── Places (taxi pickup/dropoff search) ─────────────────────────────────────
export interface Place { placeId: string; primary: string; secondary?: string; label?: string; lat?: number; lng?: number; }
export async function placesAutocomplete(q: string, near?: { lat: number; lng: number }): Promise<Place[]> {
  const qs = new URLSearchParams({ q, ...(near ? { lat: String(near.lat), lng: String(near.lng) } : {}) });
  return (await apiFetch(`/api/v1/places/autocomplete?${qs}`)).data as Place[];
}
export async function placeDetails(placeId: string): Promise<{ lat: number; lng: number; label: string }> {
  return (await apiFetch(`/api/v1/places/details?placeId=${encodeURIComponent(placeId)}`)).data;
}

export const money = (n: number) => `$${(n ?? 0).toLocaleString()}`;
