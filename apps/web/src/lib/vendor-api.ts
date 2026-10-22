'use client';

// Typed client over the EXISTING vendor endpoints — the web dashboard is
// another client on the same backend; it never invents its own order logic.
import type { SubstitutionStatus } from '@swift/types';
import { apiFetch } from './auth';
import { formatMoney, parseAmount } from './money';

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
  // [W-13] One parser for the whole app. This was the strict one and the
  // customer client had a permissive one beside it; they are the same function
  // now, in lib/money, so they cannot drift apart again.
  return parseAmount(value);
}

/**
 * The ONE money formatter for every vendor surface (the mobile client already
 * guards `!= null` before coercing; web used to not guard at all and printed
 * the letters "$NaN" onto a vendor's own order total).
 *
 * A value that is not a finite number renders an em-dash. A real zero still
 * renders "$0".
 */
export function money(value: unknown): string {
  return formatMoney(value);
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
  subStatus?: SubstitutionStatus | null;
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
  riderId?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  /** [Item 10] Set while the customer and the store disagree about a direct-MMG payment (the order is paused). */
  mmgClaimMismatchAt?: string | null;
  placedAt: string;
  appointmentSlot?: string | null;
  acceptedAt?: string | null;
  preparingAt?: string | null;
  readyAt?: string | null;
  /** `Order.totalAmount` — `Decimal(12,2)`; coerced by the seam below. */
  totalAmount: number | null;
  /** `Order.subtotalCustomer` — `Decimal(12,2)`; coerced by the seam below. */
  subtotalCustomer: number | null;
  /** [U25] The money card's lines — `Decimal`s, coerced by the seam below. */
  subtotalBase?: number | null;
  deliveryFee?: number | null;
  tipAmount?: number | null;
  discount?: number | null;
  /** [U25] Straight off the order record: why and when it was cancelled. */
  cancellationReason?: string | null;
  cancelledAt?: string | null;
  /** [AF-MOB-006] Detail route only: the order's recovery case (lib/vendor-order-view recoveryView). */
  custodyRecovery?: unknown;
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
  /** Row 52: true when the caller's role at THIS order's store (owner or
   *  manager) may confirm an MMG payment. Both routes send it. */
  canConfirmPayment?: boolean;
  /** [owner 18 Oct 2026] An accepted MMG order not marked "Paid by MMG" within 30 minutes of
   *  acceptance cancels: when (ISO) and the server's line for it. Null on every other order. */
  mmgPayBy?: string | null;
  mmgPayByLine?: string | null;

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
  /** [GUARDRAILS §8] Set when Swift does not allow the item, or is holding it for a
   *  quick check (a banned word in the partner's own text). Absent on older servers. */
  catalogueCheck?: CatalogueCheck | null;
}

/** [GUARDRAILS §8] What the server tells a partner about an item it hides. `message` is the words to show. */
export type CatalogueCheck =
  | { status: 'NOT_ALLOWED'; message: string; prohibitedClass: string; reason: string | null }
  | { status: 'WAITING_FOR_CHECK'; message: string; prohibitedClass: string; field: string; term: string };

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
    subtotalBase: toAmount(order['subtotalBase']),
    deliveryFee: toAmount(order['deliveryFee']),
    tipAmount: toAmount(order['tipAmount']),
    discount: toAmount(order['discount']),
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
// [IMAGES-E2E] The store's own logo and cover: uploaded as a photo (the API scans it and redraws
// it without camera data, then serves it to customers), or taken down. Store managers only.
type StorePhotoRow = { id: string; logoUrl: string | null; coverImageUrl: string | null };
export const uploadStorePhoto = (slot: 'logo' | 'cover', file: File) => {
  const form = new FormData();
  form.append('file', file);
  return apiFetch(`${V}/profile/${slot}`, { method: 'POST', body: form }).then((r) => r.data as StorePhotoRow);
};
export const removeStorePhoto = (slot: 'logo' | 'cover') =>
  apiFetch(`${V}/profile/${slot}`, { method: 'DELETE' }).then((r) => r.data as StorePhotoRow);

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
// [E10] The server requires a non-empty reason on every rejection; the web
// client can no longer send `{}` and let the API substitute a generic one.
export const rejectOrder = (id: string, reason: string) =>
  apiFetch(`${V}/orders/${id}/reject`, { method: 'PUT', body: JSON.stringify({ reason }) });
export const markPreparing = (id: string) => apiFetch(`${V}/orders/${id}/preparing`, { method: 'PUT', body: '{}' });
export const markReady = (id: string) => apiFetch(`${V}/orders/${id}/ready`, { method: 'PUT', body: '{}' });
export const markDelivered = (id: string) => apiFetch(`${V}/orders/${id}/delivered`, { method: 'PUT', body: '{}' });
export const setFulfillmentMode = (id: string, mode: 'PLATFORM_RIDER' | 'VENDOR_DELIVERY') =>
  apiFetch(`${V}/orders/${id}/fulfillment-mode`, { method: 'PUT', body: JSON.stringify({ mode }) });
/** [W-25] A store's attestation carries the provider reference from its own
 *  wallet message. The server refuses one without it, and refuses a reference
 *  already recorded against another order. */
export const confirmPayment = (id: string, reference: string) =>
  apiFetch(`${V}/orders/${id}/confirm-payment`, { method: 'POST', body: JSON.stringify({ reference }) });
export const completePickup = (id: string, code: string) =>
  apiFetch(`${V}/orders/${id}/complete-pickup`, { method: 'PUT', body: JSON.stringify({ code }) });
export const retryDispatch = (id: string) => apiFetch(`${V}/orders/${id}/retry-dispatch`, { method: 'POST', body: '{}' });
/** [AF-MOB-006 · U25] The store confirms returned goods are back with it (closes the return). */
export const confirmReturnReceived = (id: string) =>
  apiFetch(`${V}/orders/${id}/recovery/return-received`, { method: 'POST', body: '{}' });

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
    (r) => r.data as {
      imported: number; failedCount: number; failures: Array<{ row: number; errors: string[] }>;
      /** [GUARDRAILS §8] Imported rows a banned word is holding for a quick check (absent on older servers). */
      waitingForCheck?: Array<{ row: number; name: string }>; waitingForCheckCount?: number;
      /** [IMAGES-E2E PR4] Imported rows whose photo address was not used (absent on older servers). */
      notes?: Array<{ row: number; note: string }>; notesCount?: number;
    },
  );

// ── Analytics + money ────────────────────────────────────────────────────────
export const getOverview = () => apiFetch(`${V}/analytics/overview`).then((r) => r.data);
export const getCashSettlements = () => apiFetch(`${V}/cash-settlements`).then((r) => r.data);
// [W-26] A settlement confirmation carries the amount the confirmer says
// changed hands. The server refuses any figure that is not the ledger's own, so
// a mis-click on the wrong row cannot close a debt.
export const confirmSettlement = (id: string, amount: string | number) =>
  apiFetch(`${V}/cash-settlements/${id}/confirm`, { method: 'POST', body: JSON.stringify({ amount }) });
