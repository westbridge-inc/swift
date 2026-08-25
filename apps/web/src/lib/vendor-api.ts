'use client';

// Typed client over the EXISTING vendor endpoints — the web dashboard is
// another client on the same backend; it never invents its own order logic.
import { apiFetch } from './auth';

const V = '/api/v1/vendor';

export interface Store {
  id: string;
  name: string;
  vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
  isCurrentlyOpen: boolean;
  acceptingOrders: boolean;
  city: string | null;
  isVerified: boolean;
}

// ── The money seam ───────────────────────────────────────────────────────────
// Every vendor order/catalogue route returns RAW Prisma rows, so every
// `@db.Decimal` column arrives as a **STRING** (`"1300.00"`), never a JS number:
// there is no global Decimal `toJSON` patch and no Prisma result extension that
// touches serialisation. Coercion therefore happens HERE, once, on the way in —
// never at a render site, where a typo silently becomes `$NaN`.

/**
 * Coerce ONE wire value to a finite number, or `null` when it is not money.
 *
 * `null` means "the server did not give me this figure" and the UI must say so
 * (em-dash), because a real 0 and an invented 0 look identical and mean
 * opposite things. Deliberately strict: `undefined`, `null`, `''`, `'abc'`,
 * booleans, arrays and objects are all `null` — `Number('')` and `Number([])`
 * are both `0`, which is exactly the invented zero this guard exists to stop.
 */
export function toAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The ONE money formatter for every vendor surface (the mobile client already
 * guards `!= null` before coercing; web used to not guard at all and printed
 * the letters "$NaN" onto a vendor's own order total).
 *
 * A value that is not a finite number renders an em-dash — never "$NaN", never
 * "$0". A real zero still renders "$0".
 */
export function money(value: unknown): string {
  const amount = toAmount(value);
  if (amount === null) return '—';
  return `$${Math.round(amount).toLocaleString()}`;
}

export interface OrderLine {
  id: string;
  itemId: string;
  name: string;
  quantity: number;
  /** `OrderItem.totalCustomer` — `Decimal(10,2)`; coerced by the seam below. */
  totalCustomer: number | null;
  /** `OrderItem.specialInstructions` — the per-line note the customer typed. */
  specialInstructions?: string | null;
  /** `OrderItem.substitutePrice` — `Decimal(10,2)`; coerced by the seam below. */
  substitutePrice?: number | null;
  picked?: boolean;
  subStatus?: 'NONE' | 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'REFUNDED' | null;
  substituteItemId?: string | null;
  substituteName?: string | null;

  // ── Never sent — kept as tombstones so the lie cannot come back ──────────
  /** PHANTOM. There is no `totalPrice` column; the line total is `totalCustomer`. */
  totalPrice?: never;
  /** PHANTOM. The per-line note column is `specialInstructions`. */
  notes?: never;
  /**
   * NOT SELECTED. `selectedOptions` is an `OrderItemOption[]` RELATION and both
   * vendor routes use `include: { items: true }`, which returns scalars only.
   */
  selectedOptions?: never;
}

export interface VendorOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderType: string;
  fulfillment?: string | null;
  fulfillmentMode?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  placedAt: string;
  acceptedAt?: string | null;
  preparingAt?: string | null;
  readyAt?: string | null;
  /** `Order.totalAmount` — `Decimal(12,2)`; coerced by the seam below. */
  totalAmount: number | null;
  /** `Order.subtotalCustomer` — `Decimal(12,2)`; coerced by the seam below. */
  subtotalCustomer: number | null;
  deliveryAddress?: string | null;
  pickupAddress?: string | null;
  /** `Order.deliveryInstructions` — the order-level note the customer typed. */
  deliveryInstructions?: string | null;
  estimatedPrepTime?: number | null;
  items: OrderLine[];
  customer?: { id: string; firstName: string | null; lastName: string | null; phone?: string | null; avatar?: string | null } | null;
  rider?: { user?: { firstName: string | null; lastName: string | null; phone: string | null } | null } | null;
  /**
   * The two routes select DIFFERENT vendor columns: the board sends
   * `{ id, name, selfDeliveryEnabled }`, the detail sends
   * `{ vendorType, selfDeliveryEnabled }`. Every field is therefore optional.
   */
  vendor?: { id?: string; name?: string; vendorType?: string; selfDeliveryEnabled?: boolean } | null;
  /** Detail route only (`GET /orders/:id`). */
  statusHistory?: Array<{ status: string; createdAt: string; note?: string | null }>;

  // ── Never sent — kept as tombstones so the lie cannot come back ──────────
  /** PHANTOM. There is no `total` column; the order total is `totalAmount`. */
  total?: never;
  /** PHANTOM. There is no `subtotal` column; it is `subtotalCustomer`. */
  subtotal?: never;
  /** PHANTOM. There is no `notes` column; it is `deliveryInstructions`. */
  notes?: never;
  /** PHANTOM. There is no `paymentConfirmedAt` column anywhere in the schema. */
  paymentConfirmedAt?: never;
  /**
   * HND-003: the vendor is the pickup-code VERIFIER and must NEVER read the
   * code, or it could close a handover with the customer absent. Both vendor
   * routes strip it (`omit: HANDOVER_SECRETS_OMIT` /
   * `omit: { pickupCode, pickupCodeAttempts, ridePin }`), so it is structurally
   * absent from this client. Typed `never` so it can never be rendered again.
   */
  pickupCode?: never;
}

export interface CatalogItem {
  id: string;
  name: string;
  description?: string | null;
  /** `Item.basePrice` — `Decimal`; coerced by the seam below. */
  basePrice: number | null;
  sku?: string | null;
  unit?: string | null;
  stockQuantity?: number | null;
  lowStockThreshold?: number | null;
  isAvailable: boolean;
  imageUrl?: string | null;
  substitutionGroup?: string | null;
  category?: { id: string; name: string } | null;
}

// ── Normalisers: the ONLY place a wire Decimal becomes a JS number ───────────
// Each spreads the raw row first, so every field the server sends survives
// untouched; only the money columns are replaced with guarded numbers.

function normalizeOrderLine(raw: unknown): OrderLine {
  const line = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(line as unknown as OrderLine),
    totalCustomer: toAmount(line['totalCustomer']),
    substitutePrice: toAmount(line['substitutePrice']),
  };
}

export function normalizeVendorOrder(raw: unknown): VendorOrder {
  const order = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(order as unknown as VendorOrder),
    totalAmount: toAmount(order['totalAmount']),
    subtotalCustomer: toAmount(order['subtotalCustomer']),
    // Both routes `include: { items: true }`, so this is always an array; the
    // guard only stops a malformed payload from crashing the whole board.
    items: Array.isArray(order['items']) ? order['items'].map(normalizeOrderLine) : [],
  };
}

function normalizeCatalogItem(raw: unknown): CatalogItem {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    ...(item as unknown as CatalogItem),
    basePrice: toAmount(item['basePrice']),
  };
}

// ── Stores / profile ─────────────────────────────────────────────────────────
export const getStores = () =>
  apiFetch(`${V}/stores`).then((r) => r.data as { stores: Store[]; selectedId: string; myRole: string });
export const getProfile = () => apiFetch(`${V}/profile`).then((r) => r.data);
export const updateProfile = (body: Record<string, unknown>) =>
  apiFetch(`${V}/profile`, { method: 'PUT', body: JSON.stringify(body) });
// NB: these two routes are registered as `/vendor/toggle-*` UNDER the
// `/api/v1/vendor` prefix, so their real path is double-prefixed
// (`/api/v1/vendor/vendor/toggle-open`). The mobile client already calls the
// double-prefix; the single-prefix path 404s. Matching it here so the web
// vendor dashboard can actually open / start accepting orders. (Consistency
// cleanup — collapsing the route strings to single-prefix and updating mobile
// — is tracked separately; it is breaking for the double-prefix callers.)
export const toggleOpen = (isCurrentlyOpen: boolean) =>
  apiFetch(`${V}/vendor/toggle-open`, { method: 'PUT', body: JSON.stringify({ isCurrentlyOpen }) });
export const toggleOrders = (acceptingOrders: boolean) =>
  apiFetch(`${V}/vendor/toggle-orders`, { method: 'PUT', body: JSON.stringify({ acceptingOrders }) });
export const getHours = () => apiFetch(`${V}/hours`).then((r) => r.data);
export const putHours = (hours: Array<{ dayOfWeek: number; openTime?: string; closeTime?: string; isClosed: boolean }>) =>
  apiFetch(`${V}/hours`, { method: 'PUT', body: JSON.stringify({ hours }) });
export const getSubscription = () => apiFetch(`${V}/subscription`).then((r) => r.data);

// ── Orders ───────────────────────────────────────────────────────────────────
export const getOrders = (
  params: { status?: string; search?: string; page?: number; limit?: number } = {},
): Promise<{ orders: VendorOrder[]; meta: unknown }> => {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.search) q.set('search', params.search);
  q.set('page', String(params.page ?? 1));
  q.set('limit', String(params.limit ?? 50));
  return apiFetch(`${V}/orders?${q}`).then((r) => {
    const rows: unknown[] = Array.isArray(r.data) ? r.data : [];
    return { orders: rows.map(normalizeVendorOrder), meta: r.meta };
  });
};
export const getOrder = (id: string): Promise<VendorOrder> =>
  apiFetch(`${V}/orders/${id}`).then((r) => normalizeVendorOrder(r.data));
export const acceptOrder = (id: string, estimatedPrepTime?: number) =>
  apiFetch(`${V}/orders/${id}/accept`, { method: 'PUT', body: JSON.stringify(estimatedPrepTime ? { estimatedPrepTime } : {}) });
export const rejectOrder = (id: string, reason?: string) =>
  apiFetch(`${V}/orders/${id}/reject`, { method: 'PUT', body: JSON.stringify(reason ? { reason } : {}) });
export const markPreparing = (id: string) => apiFetch(`${V}/orders/${id}/preparing`, { method: 'PUT', body: '{}' });
export const markReady = (id: string) => apiFetch(`${V}/orders/${id}/ready`, { method: 'PUT', body: '{}' });
export const confirmPayment = (id: string) => apiFetch(`${V}/orders/${id}/confirm-payment`, { method: 'POST', body: '{}' });
export const completePickup = (id: string, code: string) =>
  apiFetch(`${V}/orders/${id}/complete-pickup`, { method: 'PUT', body: JSON.stringify({ code }) });
export const retryDispatch = (id: string) => apiFetch(`${V}/orders/${id}/retry-dispatch`, { method: 'POST', body: '{}' });

// ── Shelf picking (grocery/goods) ────────────────────────────────────────────
export const setPicked = (orderId: string, lineId: string, picked: boolean) =>
  apiFetch(`${V}/orders/${orderId}/items/${lineId}/picked`, { method: 'PUT', body: JSON.stringify({ picked }) });
export const proposeSubstitution = (orderId: string, lineId: string, substituteItemId: string) =>
  apiFetch(`${V}/orders/${orderId}/items/${lineId}/substitute`, { method: 'POST', body: JSON.stringify({ substituteItemId }) });
export const refundLine = (orderId: string, lineId: string) =>
  apiFetch(`${V}/orders/${orderId}/items/${lineId}/refund-line`, { method: 'POST', body: '{}' });

// ── Catalogue ────────────────────────────────────────────────────────────────
export const getItems = (
  params: { search?: string; categoryId?: string; isAvailable?: string } = {},
): Promise<CatalogItem[]> => {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.categoryId) q.set('categoryId', params.categoryId);
  if (params.isAvailable) q.set('isAvailable', params.isAvailable);
  const qs = q.toString();
  return apiFetch(`${V}/items${qs ? `?${qs}` : ''}`).then((r) => {
    const rows: unknown[] = Array.isArray(r.data) ? r.data : [];
    return rows.map(normalizeCatalogItem);
  });
};
export const getLowStock = (): Promise<CatalogItem[]> =>
  apiFetch(`${V}/items/low-stock`).then((r) => {
    const rows: unknown[] = Array.isArray(r.data) ? r.data : [];
    return rows.map(normalizeCatalogItem);
  });
export const getCategories = () => apiFetch(`${V}/categories`).then((r) => r.data as Array<{ id: string; name: string }>);
export const updateItem = (id: string, body: Record<string, unknown>) =>
  apiFetch(`${V}/items/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const setItemAvailability = (id: string, isAvailable: boolean) =>
  apiFetch(`${V}/items/${id}/availability`, { method: 'PUT', body: JSON.stringify({ isAvailable }) });
export const adjustStock = (id: string, delta: number, reason: 'RECEIVED' | 'DAMAGED' | 'MANUAL' | 'RECONCILE' | 'RETURN', note?: string) =>
  apiFetch(`${V}/items/${id}/adjust`, { method: 'POST', body: JSON.stringify({ delta, reason, ...(note ? { note } : {}) }) });

// ── CSV / Excel import (the desktop star) ────────────────────────────────────
export const templateUrl = () => `${V}/items/import/template`;
export const automapCsv = (csv: string) =>
  apiFetch(`${V}/items/import/automap`, { method: 'POST', body: JSON.stringify({ csv }) }).then(
    (r) => r.data as { mapping: Record<string, string>; rowCount: number; preview: Record<string, string>[]; normalizedCsv: string },
  );
export const automapXlsx = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return apiFetch(`${V}/items/import/xlsx`, { method: 'POST', body: form }).then(
    (r) => r.data as { mapping: Record<string, string>; rowCount: number; preview: Record<string, string>[]; normalizedCsv: string },
  );
};
export const confirmImport = (csv: string) =>
  apiFetch(`${V}/items/import`, { method: 'POST', body: JSON.stringify({ csv }) }).then(
    (r) => r.data as { imported: number; failedCount: number; failures: Array<{ row: number; errors: string[] }> },
  );

// ── Analytics + money ────────────────────────────────────────────────────────
export const getOverview = () => apiFetch(`${V}/analytics/overview`).then((r) => r.data);
export const getCashSettlements = () => apiFetch(`${V}/cash-settlements`).then((r) => r.data);
export const confirmSettlement = (id: string) =>
  apiFetch(`${V}/cash-settlements/${id}/confirm`, { method: 'POST', body: '{}' });
