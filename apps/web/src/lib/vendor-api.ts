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

export interface OrderLine {
  id: string;
  itemId: string;
  name: string;
  quantity: number;
  totalPrice: number;
  selectedOptions?: unknown;
  notes?: string | null;
  picked?: boolean;
  subStatus?: 'NONE' | 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'REFUNDED' | null;
  substituteItemId?: string | null;
  substituteName?: string | null;
}

export interface VendorOrder {
  id: string;
  orderNumber: string;
  status: string;
  orderType: string;
  fulfillment?: string | null;
  paymentMethod?: string | null;
  paymentConfirmedAt?: string | null;
  placedAt: string;
  total: number;
  subtotal?: number;
  deliveryAddress?: string | null;
  pickupAddress?: string | null;
  pickupCode?: string | null;
  notes?: string | null;
  estimatedPrepTime?: number | null;
  items: OrderLine[];
  customer?: { id: string; firstName: string | null; lastName: string | null } | null;
  rider?: { user?: { firstName: string | null; lastName: string | null; phone: string | null } | null } | null;
  vendor?: { id: string; name: string; vendorType?: string } | null;
  statusHistory?: Array<{ status: string; createdAt: string; note?: string | null }>;
}

export interface CatalogItem {
  id: string;
  name: string;
  description?: string | null;
  basePrice: number;
  sku?: string | null;
  unit?: string | null;
  stockQuantity?: number | null;
  lowStockThreshold?: number | null;
  isAvailable: boolean;
  imageUrl?: string | null;
  substitutionGroup?: string | null;
  category?: { id: string; name: string } | null;
}

// ── Stores / profile ─────────────────────────────────────────────────────────
export const getStores = () =>
  apiFetch(`${V}/stores`).then((r) => r.data as { stores: Store[]; selectedId: string; myRole: string });
export const getProfile = () => apiFetch(`${V}/profile`).then((r) => r.data);
export const updateProfile = (body: Record<string, unknown>) =>
  apiFetch(`${V}/profile`, { method: 'PUT', body: JSON.stringify(body) });
export const toggleOpen = (isCurrentlyOpen: boolean) =>
  apiFetch(`${V}/toggle-open`, { method: 'PUT', body: JSON.stringify({ isCurrentlyOpen }) });
export const toggleOrders = (acceptingOrders: boolean) =>
  apiFetch(`${V}/toggle-orders`, { method: 'PUT', body: JSON.stringify({ acceptingOrders }) });
export const getHours = () => apiFetch(`${V}/hours`).then((r) => r.data);
export const putHours = (hours: Array<{ dayOfWeek: number; openTime?: string; closeTime?: string; isClosed: boolean }>) =>
  apiFetch(`${V}/hours`, { method: 'PUT', body: JSON.stringify({ hours }) });
export const getSubscription = () => apiFetch(`${V}/subscription`).then((r) => r.data);

// ── Orders ───────────────────────────────────────────────────────────────────
export const getOrders = (params: { status?: string; search?: string; page?: number; limit?: number } = {}) => {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.search) q.set('search', params.search);
  q.set('page', String(params.page ?? 1));
  q.set('limit', String(params.limit ?? 50));
  return apiFetch(`${V}/orders?${q}`).then((r) => ({ orders: r.data as VendorOrder[], meta: r.meta }));
};
export const getOrder = (id: string) => apiFetch(`${V}/orders/${id}`).then((r) => r.data as VendorOrder);
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
export const getItems = (params: { search?: string; categoryId?: string; isAvailable?: string } = {}) => {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.categoryId) q.set('categoryId', params.categoryId);
  if (params.isAvailable) q.set('isAvailable', params.isAvailable);
  const qs = q.toString();
  return apiFetch(`${V}/items${qs ? `?${qs}` : ''}`).then((r) => r.data as CatalogItem[]);
};
export const getLowStock = () => apiFetch(`${V}/items/low-stock`).then((r) => r.data as CatalogItem[]);
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
