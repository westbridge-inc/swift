'use client';

// Customer ordering client for the web app — talks to the SAME backend the
// mobile app uses (/api/v1/customer/*, /api/v1/rides/*). Auth + refresh + the
// authed fetch are shared with the partner flow via apiFetch (auth.ts).
import { apiFetch, getSessionPrincipal, sendOtp } from './auth';
import { formatAmount, parseAmount } from './money';
import type { StorefrontDetail } from './api';
import { BROWSER_API_ORIGIN as API_URL } from '@/lib/browser-api-origin';

export { sendOtp };

// ── Auth (customer) ────────────────────────────────────────────────────────
// The customer sign-in code check lives in ./customer-login, so the sign-in
// page loads it without this whole client.

// ── Types ──────────────────────────────────────────────────────────────────
export interface Vendor {
  id: string; name: string; slug: string; vendorType: string;
  logoUrl?: string | null; coverImageUrl?: string | null;
  cuisineTypes: string[];
  // [M-D6] The API spreads the shared rating surface onto every vendor; it
  // does NOT send averageRating. Declaring that field made `v.averageRating
  // ?? 0` type-check while being undefined at runtime, so every vendor card
  // on the web rendered 0.0.
  displayRating: number | null; ratingBucket: string; ratingCount: number; topRated: boolean;
  estimatedPrepTime: number; distanceKm?: number | null;
  isCurrentlyOpen: boolean; acceptingOrders: boolean; city?: string;
  deliveryFee?: number | string | null; etaMin?: number | null;
}
export interface MenuItem { id: string; name: string; description?: string; basePrice: number; imageUrl?: string | null; isAvailable: boolean; customerPrice?: number; fulfillment?: string; optionGroups?: OptionGroup[]; }

// ── Service appointments (SERVICE listings, fulfillment=APPOINTMENT) ─────────
/** GET /customer/items/:id/slots — a listing's free times on one Guyana day,
 *  the same answer the phone's slot picker reads (customer.routes.ts). */
export interface ItemSlots {
  date?: string;
  slots: string[];
  durationMinutes?: number;
  bookableWeekdays?: number[];
  serviceMode?: 'AT_BUSINESS' | 'MOBILE' | 'BOTH' | string;
  serviceRadiusKm?: number | null;
  /** Sent only with INSTANT_BOOKING on: a cash booking of this listing is confirmed at checkout. */
  instantConfirmation?: boolean;
}
export async function getItemSlots(itemId: string, date: string): Promise<ItemSlots> {
  const d = (await apiFetch(`/api/v1/customer/items/${encodeURIComponent(itemId)}/slots?date=${encodeURIComponent(date)}`)).data;
  return Array.isArray(d) ? { slots: d } : { ...d, slots: Array.isArray(d?.slots) ? d.slots : [] };
}
export interface VendorDetail extends Vendor {
  description?: string;
  /** [IMAGES-E2E PR5] imageUrl: the section's own photo (a kept one; absent from an older API). */
  categories: Array<{ id: string; name: string; imageUrl?: string | null; items: MenuItem[] }>;
}
export interface CartLine { id: string; itemId: string; name: string; quantity: number; customerPrice: number; lineTotal?: number; selectedOptions?: Record<string, string | string[]> | null; selectedOptionNames?: string[]; specialInstructions?: string | null; isAvailable?: boolean; fulfillment?: string; imageUrl?: string | null; vendorId?: string; vendorName?: string; }
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
  /** [E01] One row per future order: each store's fulfilment, fee and total, as checkout writes it. */
  vendors?: Array<{ vendorId: string; name: string; fulfillment: string; subtotal?: number; deliveryFee: number; totalAmount?: number; meetsMinimum?: boolean }>;
  paymentCapabilities?: {
    /** Changes when the vendor set or the validated MMG destination changes. */
    scope?: string;
    cash?: { available: boolean; fundsFlow: 'DIRECT_AT_HANDOVER' };
    mmg?: { available: boolean; provider?: 'MMG'; fundsFlow?: 'DIRECT_TO_VENDOR'; unavailableReason?: string | null };
    /** [PAYMENT-SIMPLIFY] MMG to the store's number (shown on the order once the store accepts). */
    mmgStoreNumber?: { available: boolean; provider?: 'MMG'; fundsFlow?: 'DIRECT_TO_VENDOR'; payTo?: 'STORE_NUMBER'; shownWhen?: 'STORE_ACCEPTS'; unavailableReason?: string | null };
  };
}

// ── Browse ────────────────────────────────────────────────────────────────
/** One card on Home's "Popular on Swift" rail — an item, opened at its store. */
export interface PopularItem {
  id: string; name: string; imageUrl: string | null; price: number;
  vendorId: string; vendorName: string; vendorType: string | null; etaMin: number | null;
}
/** The live order Home shows at the top (guests have none). */
export interface HomeActiveOrder {
  id: string; orderNumber: string; status: string; orderType?: string;
  vendor?: { id: string; name: string } | null;
}
export interface HomeFeed {
  activeOrder: HomeActiveOrder | null;
  popularItems: PopularItem[];
  featured: Vendor[];
  nearby: Vendor[];
  orderAgain: Vendor[];
  categories: Array<{ id: string; name: string; imageUrl: string | null }>;
  openVendors: Vendor[];
  closedVendors: Vendor[];
}
/** The same feed the phone app's Home reads. A position (the delivery address,
 *  or where the browser is) sorts stores by distance and fills "Near you". */
export async function getHome(near?: { lat: number; lng: number }): Promise<HomeFeed> {
  const qs = near ? `?lat=${near.lat}&lng=${near.lng}` : '';
  return (await apiFetch(`/api/v1/customer/home${qs}`, undefined, { redirectOnExpired: false })).data as HomeFeed;
}
/** [W2] The guest Home feed — the one the server renders into the page — read
 *  with no session at all, so nothing personal is ever filed under it. */
export async function getPublicHome(near?: { lat: number; lng: number }): Promise<HomeFeed> {
  const qs = near ? `?lat=${near.lat}&lng=${near.lng}` : '';
  return publicGet<HomeFeed>(`/api/v1/customer/home${qs}`);
}
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
// ── Market (goods across stores — the phone app's Market tab) ──────────────
/** The server's launch-depth verdict; the tab shows only when it says so. */
export interface MarketDepth { visible: boolean; items: number; vendors: number }
/** An item listed outside its store (the API's one ItemHit shape). */
export interface MarketItem {
  id: string; name: string; basePrice: number; imageUrl: string | null;
  vendorId: string; vendorName: string; categoryName: string | null; isNew: boolean;
  /** Is the item's store open now? Search shows closed stores' dishes too, marked
   *  (owner, 13 Oct). Absent from an older server: read as open, as before. */
  vendorIsCurrentlyOpen?: boolean;
}
export interface MarketCategory { slug: string; name: string; vertical: string }

/** Public reads with no session attached: nothing on them is personal, and a
 *  stale cookie must never turn browsing into a sign-in redirect. */
export async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.success === false) {
    throw new Error(json?.error?.message || (response.status >= 500
      ? 'Something went wrong on our side. Please try again.'
      : 'We couldn’t complete that. Please try again.'));
  }
  return json.data as T;
}

export function getMarketDepth(): Promise<MarketDepth> {
  return publicGet<MarketDepth>('/api/v1/market/depth');
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
    throw new Error('Swift couldn’t update your delivery total. Checkout is paused. Check your cart and try again.');
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
  /** [L09 · price lock] The total and line prices the customer saw. */
  expectedTotal?: number;
  expectedLines?: Array<{ lineId: string; unitPrice: number }>;
};

/**
 * [L09 · price lock] What the customer saw, sent with Place order: the quote's
 * total and each line's unit price, exactly as the server quote on screen
 * priced them. The server refuses with PRICE_CHANGED (old → new) on any
 * difference, so a price changed after the customer last looked is never
 * charged unseen. Nothing is sent when the quote has no total it can stand
 * behind (the same rule as the phone's).
 */
export function pricesAsSeen(cart: Pick<Cart, 'totalAmount' | 'items'> | null | undefined):
  Pick<CheckoutBody, 'expectedTotal' | 'expectedLines'> {
  const total = parseAmount(cart?.totalAmount);
  if (!cart || total === null) return {};
  const expectedLines = (cart.items ?? []).flatMap((line) => {
    const unitPrice = parseAmount(line.customerPrice);
    return typeof line.id === 'string' && unitPrice !== null ? [{ lineId: line.id, unitPrice }] : [];
  });
  return { expectedTotal: total, expectedLines };
}

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
/** POST /customer/addresses — the server's own fields (region is optional there, and the phone never sends it). */
export async function addAddress(body: { label: string; addressLine1: string; addressLine2?: string; city: string; region?: string; latitude: number; longitude: number; instructions?: string; isDefault?: boolean }) {
  return (await apiFetch('/api/v1/customer/addresses', { method: 'POST', body: JSON.stringify(body) })).data;
}

// ── Checkout & orders ─────────────────────────────────────────────────────
// Orders, rides, courier and place search live in their own modules
// (customer-orders, customer-rides, customer-courier, customer-places), as do
// sign-up (customer-account), search (customer-search) and the Market goods
// (customer-market): only the pages that use them load them. [PERF]
export async function checkout(body: CheckoutBody, idempotencyKey: string) {
  return (await apiFetch('/api/v1/customer/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })).data;
}
// [W-13] `Math.round(n ?? 0)` printed "GY$0" for a price the server never sent
// and "GY$NaN" for a broken one. Free and unknown are different facts, and a
// customer must never be shown either as the other.
/**
 * [WEB-REDESIGN] Customer prices read the way the phone app writes them
 * (apps/mobile/src/lib/money.ts): `$2,500`. Every price on Swift is in Guyana
 * dollars, which the footer states on every page ("Prices in GYD"); the
 * partner consoles print the same `$` (lib/money.ts formatMoney). Unparseable
 * money is still the em-dash, never a zero.
 */
export const money = (n: unknown) => formatAmount(n, '$');
