'use client';

// Customer ordering client for the web app — talks to the SAME backend the
// mobile app uses (/api/v1/customer/*, /api/v1/rides/*). Auth + refresh + the
// authed fetch are shared with the partner flow via apiFetch (auth.ts).
import { apiFetch, getSessionPrincipal, sendOtp, setTokens } from './auth';
import type { StorefrontDetail } from './api';

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
    throw new Error('No Swift account is registered to that number yet. Create your account on this page to continue.');
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

/** Mandatory transact-gate photo. The API validates the actual image bytes and
 * is the only writer of avatar/selfieCapturedAt. */
export async function uploadSelfie(file: File): Promise<{ user: any }> {
  const form = new FormData();
  form.append('file', file, file.name || 'swift-profile-photo.jpg');
  return (await apiFetch('/api/v1/auth/selfie', { method: 'POST', body: form })).data as { user: any };
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
export interface CartLine { id: string; itemId: string; name: string; quantity: number; customerPrice: number; lineTotal?: number; selectedOptionNames?: string[]; isAvailable?: boolean; fulfillment?: string; imageUrl?: string | null; vendorId?: string; vendorName?: string; }
export interface Cart {
  items: CartLine[];
  subtotal?: number;
  subtotalCustomer?: number;
  deliveryFee?: number;
  discount?: number;
  promoCode?: { code: string; discountType?: string; description?: string } | null;
  tipAmount?: number;
  totalAmount?: number;
  deliveryDistanceKm?: number;
  deliveryAddress?: { id: string; label?: string; addressLine1?: string; city?: string } | null;
  vendor?: {
    id: string;
    name: string;
    slug?: string;
    deliveryRadius?: number;
    distanceKm?: number;
    isCurrentlyOpen?: boolean;
    acceptingOrders?: boolean;
  };
  meetsMinimum?: boolean;
  minimumOrderAmount?: number;
  paymentCapabilities?: {
    cash?: { available: boolean; fundsFlow: 'DIRECT_AT_HANDOVER' };
    mmg?: { available: boolean; provider?: 'MMG'; fundsFlow?: 'DIRECT_TO_VENDOR'; unavailableReason?: string | null };
  };
}

// ── Browse ────────────────────────────────────────────────────────────────
export async function getHome() { return (await apiFetch('/api/v1/customer/home')).data; }
export async function getVendors(type?: string): Promise<Vendor[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : '';
  return (await apiFetch(`/api/v1/customer/vendors${qs}`)).data as Vendor[];
}
export async function getVendor(id: string): Promise<VendorDetail> {
  return (await apiFetch(`/api/v1/customer/vendors/${id}`)).data as VendorDetail;
}
/** Rich guest catalog used after a public storefront has already established
 * that the vendor is live. It deliberately sends no stale bearer token: a
 * scanned counter code must remain browseable even when an old web session
 * can no longer refresh. */
export async function getPublicVendor(id: string): Promise<VendorDetail> {
  const response = await fetch(`${API_URL}/api/v1/customer/vendors/${encodeURIComponent(id)}`, { cache: 'no-store' });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.success === false) {
    throw new Error(json?.error?.message || 'Could not load menu options.');
  }
  return json.data as VendorDetail;
}
export async function getPublicStorefront(slug: string): Promise<StorefrontDetail> {
  const response = await fetch(`${API_URL}/api/v1/public/storefronts/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.success === false || !json?.data) {
    throw new Error(json?.error?.message || 'Could not refresh this live store.');
  }
  return json.data as StorefrontDetail;
}
export async function searchVendors(q: string): Promise<Vendor[]> {
  return (await apiFetch(`/api/v1/customer/vendors?search=${encodeURIComponent(q)}`)).data as Vendor[];
}

// ── Cart ──────────────────────────────────────────────────────────────────
export async function getCart(options?: { redirectOnExpired?: boolean }): Promise<Cart> {
  const data = (await apiFetch('/api/v1/customer/cart', undefined, options)).data as Cart | null;
  return data ?? { items: [] };
}
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
export async function setCartAddress(addressId: string): Promise<Cart> {
  const payload = (await apiFetch('/api/v1/customer/cart/address', {
    method: 'PUT',
    body: JSON.stringify({ addressId }),
  })).data as { cart?: Cart };
  if (!payload?.cart || !Array.isArray(payload.cart.items)) {
    throw new Error('Swift did not return an updated delivery quote. Checkout stays locked.');
  }
  return payload.cart;
}

/** Compare only server-owned quote inputs and outputs. A changed fingerprint
 * means the customer must see the new cash total before checkout. */
export function cartQuoteFingerprint(cart: Cart): string {
  return JSON.stringify({
    items: cart.items.map((line) => ({
      id: line.id,
      itemId: line.itemId,
      name: line.name,
      quantity: line.quantity,
      customerPrice: line.customerPrice,
      lineTotal: line.lineTotal ?? null,
      selectedOptionNames: line.selectedOptionNames ?? [],
      isAvailable: line.isAvailable ?? null,
      fulfillment: line.fulfillment ?? null,
    })),
    vendor: cart.vendor
      ? {
          id: cart.vendor.id,
          name: cart.vendor.name,
          slug: cart.vendor.slug ?? null,
          isCurrentlyOpen: cart.vendor.isCurrentlyOpen ?? null,
          acceptingOrders: cart.vendor.acceptingOrders ?? null,
        }
      : null,
    deliveryAddressId: cart.deliveryAddress?.id ?? null,
    deliveryDistanceKm: cart.deliveryDistanceKm ?? cart.vendor?.distanceKm ?? null,
    deliveryRadius: cart.vendor?.deliveryRadius ?? null,
    subtotalCustomer: cart.subtotalCustomer ?? cart.subtotal ?? null,
    deliveryFee: cart.deliveryFee ?? null,
    discount: cart.discount ?? null,
    tipAmount: cart.tipAmount ?? null,
    totalAmount: cart.totalAmount ?? null,
    promoCode: cart.promoCode?.code ?? null,
    meetsMinimum: cart.meetsMinimum ?? null,
    minimumOrderAmount: cart.minimumOrderAmount ?? null,
  });
}

export type CheckoutBody = {
  paymentMethod: 'CASH' | 'MOBILE_MONEY';
  tipAmount?: number;
  deliveryInstructions?: string;
  fulfillmentSelections?: Record<string, string>;
  promoCode?: string;
  appointments?: Array<{ itemId: string; slotStart: string; mode?: string }>;
};

export type CheckoutAttempt = { signature: string; key: string };
const CHECKOUT_ATTEMPT_STORAGE_PREFIX = 'swift_web_checkout_attempt';

function checkoutAttemptStorageKey(): string | null {
  const principal = getSessionPrincipal();
  return principal ? `${CHECKOUT_ATTEMPT_STORAGE_PREFIX}:${principal}` : null;
}

export function checkoutAttemptSignature(cart: Cart, body: CheckoutBody): string {
  return JSON.stringify({ cart: cartQuoteFingerprint(cart), body });
}

export function readCheckoutAttempt(): CheckoutAttempt | null {
  if (typeof window === 'undefined') return null;
  const storageKey = checkoutAttemptStorageKey();
  if (!storageKey) return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as Partial<CheckoutAttempt> | null;
    if (typeof parsed?.signature === 'string' && typeof parsed.key === 'string') {
      return { signature: parsed.signature, key: parsed.key };
    }
  } catch {
    // Session storage can be unavailable or contain unreadable data. In that
    // case there is no safe durable attempt to replay.
  }
  return null;
}

export function persistCheckoutAttempt(attempt: CheckoutAttempt): void {
  if (typeof window === 'undefined') return;
  const storageKey = checkoutAttemptStorageKey();
  if (!storageKey) return;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(attempt));
  } catch {
    // In-memory guards still prevent same-render double submits when browser
    // storage is unavailable; the UI must not claim reload-safe replay then.
  }
}

export function clearCheckoutAttempt(): void {
  if (typeof window === 'undefined') return;
  const storageKey = checkoutAttemptStorageKey();
  try {
    if (storageKey) window.sessionStorage.removeItem(storageKey);
    // Remove the unscoped key used by pre-migration sessions.
    window.sessionStorage.removeItem(CHECKOUT_ATTEMPT_STORAGE_PREFIX);
  } catch {
    // Storage can be disabled; there is nothing durable to clear in that case.
  }
}

// ── Addresses ─────────────────────────────────────────────────────────────
export async function getAddresses(options?: { redirectOnExpired?: boolean }): Promise<any[]> {
  return (await apiFetch('/api/v1/customer/addresses', undefined, options)).data as any[];
}
export async function addAddress(body: { label: string; addressLine1: string; city: string; region: string; latitude: number; longitude: number; isDefault?: boolean }) {
  return (await apiFetch('/api/v1/customer/addresses', { method: 'POST', body: JSON.stringify(body) })).data;
}

// ── Checkout & orders ─────────────────────────────────────────────────────
export async function checkout(body: CheckoutBody, idempotencyKey: string) {
  return (await apiFetch('/api/v1/customer/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })).data;
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
export async function getRide(id: string): Promise<any> { return (await apiFetch(`/api/v1/rides/${encodeURIComponent(id)}`)).data; }
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

export const money = (n: number) => `GY$${Math.round(n ?? 0).toLocaleString()}`;
