import { useCallback, useEffect, useMemo, useState } from 'react';
import { Vibration } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorApi } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { useVendorPreview } from '../stores/vendorPreview';
import { vendorPreviewDataset, previewQuery, previewMutation, type VendorPreviewDataset } from '../lib/vendorPreviewData';

async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  return r?.data?.data as T;
}
async function tryUnwrap<T = any>(p: Promise<any>): Promise<T | null> {
  try {
    return await unwrap<T>(p);
  } catch {
    return null;
  }
}

// Vendor PREVIEW (R4): when a prospective vendor is walking a SAMPLE dashboard of
// a chosen business type, the data hooks return that type's canned dataset (with
// their real, auth-less query disabled) and every mutation no-ops — strictly
// read-only. `pv` is null for a normal session AND for the legacy pending-vendor
// peek (previewType null), so both keep their real behaviour. usePreviewDataset()
// is called unconditionally in each hook so hook order stays stable.
function usePreviewDataset(): VendorPreviewDataset | null {
  const previewType = useVendorPreview((s) => s.previewType);
  return useMemo(() => (previewType ? vendorPreviewDataset(previewType) : null), [previewType]);
}

/** The stores this account works in; `store` is the selected one and
 *  `myRole` is OWNER / MANAGER / STAFF (drives which tools the UI shows). */
export function useVendorProfile() {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'profile'],
    queryFn: () => tryUnwrap(vendorApi.profile()),
    retry: false,
    refetchInterval: 20000,
    enabled: !pv,
  });
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  if (pv) return { owner: pv.owner, store: pv.store, stores: pv.stores, myRole: 'OWNER' as const, isLoading: false };
  const owner: any = q.data ?? null;
  const stores: any[] = owner?.vendors ?? [];
  const store: any = stores.find((v) => v.id === selectedStoreId) ?? stores[0] ?? null;
  const myRole: 'OWNER' | 'MANAGER' | 'STAFF' = owner?.myRole ?? 'OWNER';
  return { owner, store, stores, myRole, isLoading: q.isLoading };
}

// ─── Reviews (manager+ replies) ──────────────────────────────────────────────

export function useMyStoreReviews() {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'reviews'],
    queryFn: async () => {
      const r = await vendorApi.reviews();
      return r?.data as {
        data: any[];
        summary: { averageRating: number; totalReviews: number; distribution: Record<string, number> };
      };
    },
    enabled: !pv,
  });
  return pv ? previewQuery({ data: [], summary: { averageRating: 4.8, totalReviews: 0, distribution: {} } }) : q;
}

export function useRespondReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) => unwrap(vendorApi.respondReview(id, response)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'reviews'] }),
  });
}

// ─── Promotions (manager+) ───────────────────────────────────────────────────

export function useVendorPromos(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({ queryKey: ['vendor', 'promos'], queryFn: () => unwrap<any[]>(vendorApi.promos()), enabled: enabled && !pv });
  return pv ? previewQuery([] as any[]) : q;
}

export function useCreatePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof vendorApi.createPromo>[0]) => unwrap(vendorApi.createPromo(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'promos'] }),
  });
}

export function useUpdatePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { isActive?: boolean; validUntil?: string } }) =>
      unwrap(vendorApi.updatePromo(id, data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'promos'] }),
  });
}

export function useDeletePromo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deletePromo(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'promos'] }),
  });
}

// ─── Staff & roles (owner-only) ──────────────────────────────────────────────

export function useVendorStaff(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'staff'],
    queryFn: () => unwrap<any[]>(vendorApi.staff()),
    enabled: enabled && !pv,
  });
  return pv ? previewQuery([] as any[]) : q;
}

export function useAddStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { phone: string; role: 'MANAGER' | 'STAFF' }) => unwrap(vendorApi.addStaff(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'staff'] }),
  });
}

export function useRemoveStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.removeStaff(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'staff'] }),
  });
}

export function useUpdateStaffRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'MANAGER' | 'STAFF' }) => unwrap(vendorApi.updateStaff(id, role)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'staff'] }),
  });
}

export function useVendorOrders(enabled: boolean) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'orders'],
    queryFn: () => unwrap(vendorApi.orders()),
    enabled: enabled && !pv,
    refetchInterval: enabled && !pv ? 12000 : false,
  });
  return pv ? previewQuery(pv.orders) : q;
}

/** Live board: join the store's socket room and refresh the order queries the
 *  moment the server says something happened (new order, status change, prep
 *  signal) instead of waiting out the 12s poll — the poll stays as the
 *  reconnect safety net. A new order also buzzes the phone: the board is a
 *  counter appliance, not a screen someone stares at. */
export function useVendorOrdersLive(vendorId: string | undefined) {
  const qc = useQueryClient();
  const previewType = useVendorPreview((s) => s.previewType);
  // NEW-ORDER takeover queue (alerts spec §A1): every order:new lands here;
  // the takeover component works it FIFO and dismisses per order.
  const [takeover, setTakeover] = useState<Array<{ orderId: string; orderNumber?: string }>>([]);
  useEffect(() => {
    if (!vendorId || previewType) return; // preview: no socket, no live buzz
    connectSocket();
    const s = getSocket();
    const join = () => s.emit('vendor:subscribe', { vendorId });
    join();
    s.on('connect', join); // rooms are per-connection — re-join after reconnects
    const refresh = () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] });
    const onNew = (payload?: { orderId?: string; orderNumber?: string }) => {
      Vibration.vibrate(400);
      if (payload?.orderId) {
        setTakeover((q) =>
          q.some((x) => x.orderId === payload.orderId)
            ? q
            : [...q, { orderId: payload.orderId!, orderNumber: payload.orderNumber }],
        );
      }
      refresh();
    };
    s.on('order:new', onNew);
    s.on('order:status_changed', refresh);
    s.on('order:prep_update', refresh);
    return () => {
      s.off('connect', join);
      s.off('order:new', onNew);
      s.off('order:status_changed', refresh);
      s.off('order:prep_update', refresh);
    };
  }, [vendorId, qc, previewType]);

  const dismissTakeover = useCallback(
    (orderId: string) => setTakeover((q) => q.filter((x) => x.orderId !== orderId)),
    [],
  );
  return { takeover, dismissTakeover };
}

/** Full order drill-down (line items, status log, customer/rider contacts).
 *  Keyed under ['vendor','orders'] so order-action mutations refresh it too. */
export function useVendorOrder(id: string | undefined) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'orders', 'detail', id],
    queryFn: () => unwrap<any>(vendorApi.order(id!)),
    enabled: !!id && !pv,
    refetchInterval: 15000,
  });
  return pv ? previewQuery(pv.orders.find((o) => o.id === id) ?? pv.orders[0]) : q;
}

export type OrderHistoryFilters = { status?: string; search?: string; page: number };

/** Paginated, filterable order history (the endpoint's status/search/page params). */
export function useVendorOrderHistory(filters: OrderHistoryFilters) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'orders', 'history', filters],
    queryFn: async () => {
      const r = await vendorApi.orders({ ...filters, limit: 20 });
      return r?.data as { data: any[]; meta: { page: number; limit: number; total: number; hasNext: boolean } };
    },
    enabled: !pv,
    placeholderData: (prev) => prev,
  });
  return pv ? previewQuery({ data: pv.orders, meta: { page: 1, limit: 20, total: pv.orders.length, hasNext: false } }) : q;
}

export function useVendorSubscription(enabled = true) {
  // Billing is owner-only (staff & roles §4.1) — staff sessions skip the call.
  const pv = usePreviewDataset();
  const q = useQuery({ queryKey: ['vendor', 'subscription'], queryFn: () => unwrap(vendorApi.subscription()), enabled: enabled && !pv });
  return pv ? previewQuery(pv.subscription) : q;
}

/** "Find a mover again" after dispatch exhausted — clears the cascade's
 *  decline memory server-side and searches again from the tightest radius. */
export function useRetryDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.retryDispatch(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
}

export function useToggleOpen() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => unwrap(vendorApi.toggleOpen()), onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }) });
}
export function useToggleOrders() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => unwrap(vendorApi.toggleOrders()), onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }) });
}
/** Turn self-delivery on/off. When on, the server routes this store's delivery
 *  orders to VENDOR_DELIVERY (the vendor delivers) instead of dispatching a rider. */
export function useSetSelfDelivery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (selfDeliveryEnabled: boolean) => unwrap(vendorApi.updateProfile({ selfDeliveryEnabled })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }),
  });
}

export function useOrderAction() {
  const pv = usePreviewDataset();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({
      id,
      action,
      code,
    }: {
      id: string;
      action: 'accept' | 'preparing' | 'ready' | 'reject' | 'complete-pickup' | 'complete-appointment' | 'confirm-payment';
      code?: string;
    }) => {
      if (action === 'accept') return unwrap(vendorApi.acceptOrder(id));
      if (action === 'confirm-payment') return unwrap(vendorApi.confirmPayment(id));
      if (action === 'preparing') return unwrap(vendorApi.preparing(id));
      if (action === 'ready') return unwrap(vendorApi.ready(id));
      if (action === 'complete-pickup') return unwrap(vendorApi.completePickup(id, code));
      if (action === 'complete-appointment') return unwrap(vendorApi.completeAppointment(id));
      return unwrap(vendorApi.reject(id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
  return pv ? previewMutation() : m;
}

/** MMG cash ledger — delivery fees this store owes riders in cash (the
 *  customer's MMG payment, fee included, landed in the store's wallet). */
export function useVendorCashSettlements(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'cash-settlements'],
    queryFn: () => unwrap<any>(vendorApi.cashSettlements()),
    enabled: enabled && !pv,
  });
  return pv ? previewQuery([] as any[]) : q;
}
/** "We handed the rider their fee" — the store's half of the dual confirm. */
export function useConfirmVendorCashSettlement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.confirmCashSettlement(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'cash-settlements'] }),
  });
}

/** Grocery picking (§5.3): tick lines, swap out-of-stock, refund a line. */
export function usePickingActions() {
  const qc = useQueryClient();
  const invalidate = (orderId: string) => {
    qc.invalidateQueries({ queryKey: ['vendor', 'order', orderId] });
    qc.invalidateQueries({ queryKey: ['vendor', 'orders'] });
  };
  const setPicked = useMutation({
    mutationFn: ({ orderId, lineId, picked }: { orderId: string; lineId: string; picked: boolean }) =>
      unwrap(vendorApi.setLinePicked(orderId, lineId, picked)),
    onSuccess: (_d, v) => invalidate(v.orderId),
  });
  const substitute = useMutation({
    mutationFn: ({ orderId, lineId, substituteItemId }: { orderId: string; lineId: string; substituteItemId: string }) =>
      unwrap(vendorApi.proposeSubstitution(orderId, lineId, substituteItemId)),
    onSuccess: (_d, v) => invalidate(v.orderId),
  });
  const refundLine = useMutation({
    mutationFn: ({ orderId, lineId }: { orderId: string; lineId: string }) =>
      unwrap(vendorApi.refundLine(orderId, lineId)),
    onSuccess: (_d, v) => invalidate(v.orderId),
  });
  return { setPicked, substitute, refundLine };
}

// ─── Menu ────────────────────────────────────────────────────────────────────

/** Categories with their nested items (the menu, grouped by section). */
export function useVendorMenu() {
  const pv = usePreviewDataset();
  const q = useQuery({ queryKey: ['vendor', 'menu'], queryFn: () => unwrap<any[]>(vendorApi.categories()), enabled: !pv });
  return pv ? previewQuery(pv.menu.categories) : q;
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string }) => unwrap(vendorApi.createCategory(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string } }) => unwrap(vendorApi.updateCategory(id, data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

/** Deleting a category removes its items too — the UI must confirm with the count. */
export function useDeleteCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deleteCategory(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

/** Create (no id) or update (id present) an item. */
export function useSaveItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id?: string; data: any }) =>
      id ? unwrap(vendorApi.updateItem(id, data)) : unwrap(vendorApi.createItem(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deleteItem(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useSetItemAvailability() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      unwrap(vendorApi.setItemAvailability(id, isAvailable)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

// ─── Modifiers (option groups + options) ─────────────────────────────────────
// Each mutation resolves to the updated group (with options) so the editor can
// refresh its local list without waiting for the menu query.

export function useAddOptionGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, data }: { itemId: string; data: { name: string; isRequired?: boolean; minSelect?: number; maxSelect?: number } }) =>
      unwrap<any>(vendorApi.addOptionGroup(itemId, data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useDeleteOptionGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deleteOptionGroup(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useAddOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, data }: { groupId: string; data: { name: string; additionalPrice?: number } }) =>
      unwrap<any>(vendorApi.addOption(groupId, data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useDeleteOption() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deleteOption(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

/** Upload (or replace) an item's photo — multipart to the StorageProvider. */
export function useUploadItemImage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: { uri: string; name: string; type: string } }) => {
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
      return unwrap(vendorApi.uploadItemImage(id, form));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

// ─── Insights / settings ──────────────────────────────────────────────────────

// `enabled` lets a STAFF board suppress this MANAGER-only query (it would 403,
// and a 403 reads as empty money — a misleading GYD 0). See vendorRbac.
export function useVendorAnalytics(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'analytics'],
    queryFn: () => unwrap<any>(vendorApi.analytics()),
    refetchInterval: 30000,
    enabled: !pv && enabled,
  });
  return pv ? previewQuery(pv.analytics) : q;
}

/** Daily revenue series for the chart (endpoint pre-fills gap days with 0). */
export function useVendorRevenue(days = 14) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'analytics', 'revenue', days],
    queryFn: () => unwrap<any>(vendorApi.analyticsRevenue(days)),
    enabled: !pv,
  });
  return pv ? previewQuery(pv.revenue) : q;
}

/** Operational quality: acceptance/cancellation rates + accept/prep timing. */
export function useVendorOps(days = 30) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'analytics', 'ops', days],
    queryFn: () => unwrap<any>(vendorApi.analyticsOps(days)),
    enabled: !pv,
  });
  return pv ? previewQuery(pv.ops) : q;
}

/** Orders by local hour (last 30 days) — the §4.1 busy-hours view. */
export function useBusyHours() {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'analytics', 'busy-hours'],
    queryFn: () => unwrap<any>(vendorApi.analyticsBusyHours()),
    enabled: !pv,
  });
  return pv ? previewQuery(pv.busyHours) : q;
}

/** Top items by lifetime + last-30-days order counts. */
export function usePopularItems(limit = 8) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'analytics', 'popular', limit],
    queryFn: () => unwrap<any>(vendorApi.analyticsPopularItems(limit)),
    enabled: !pv,
  });
  return pv ? previewQuery(pv.popularItems) : q;
}

/** Storefront QR + deep link (manager+). Static per store — cache hard. */
export function useVendorQr(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'qr'],
    queryFn: () => unwrap<{ deepLink: string; svg: string; vendorName: string }>(vendorApi.qr()),
    enabled: enabled && !pv,
    staleTime: Infinity,
  });
  return pv ? previewQuery(null) : q;
}

export type DayHours = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };

export function useVendorHours() {
  const pv = usePreviewDataset();
  const q = useQuery({ queryKey: ['vendor', 'hours'], queryFn: () => unwrap<DayHours[]>(vendorApi.hours()), enabled: !pv });
  return pv ? previewQuery(pv.hours) : q;
}

export interface VendorBooking {
  id: string;
  serviceName: string;
  price: number;
  slotStart: string;
  slotEnd: string;
  status: string;
  orderId: string | null;
  customer: { firstName: string } | null;
}

/** The Services SCHEDULE: upcoming appointments (default two-week window) for the
 *  selected store, from GET /vendor/bookings. Drives the booking-calendar agenda. */
export function useVendorBookings(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery<VendorBooking[]>({
    queryKey: ['vendor', 'bookings'],
    queryFn: () => unwrap<VendorBooking[]>(vendorApi.bookings()),
    enabled: enabled && !pv,
    refetchInterval: 60000,
  });
  return pv ? previewQuery(pv.bookings) : q;
}

export function useSetHours() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hours: DayHours[]) => unwrap(vendorApi.setHours(hours)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendor', 'hours'] });
      qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
    },
  });
}

/** Map a pasted store CSV's columns to Swift fields (preview only, no import). */
/** Pick-a-file imports: xlsx and PDF menus land in the same automap preview. */
export function useImportFile() {
  return useMutation({
    mutationFn: ({ kind, file }: { kind: 'xlsx' | 'menu-pdf'; file: { uri: string; name: string; type: string } }) => {
      const form = new FormData();
      form.append('file', file as unknown as Blob);
      return unwrap<any>(kind === 'xlsx' ? vendorApi.importXlsx(form) : vendorApi.importMenuPdf(form));
    },
  });
}

export function useImportAutomap() {
  return useMutation({ mutationFn: (csv: string) => unwrap<any>(vendorApi.importAutomap(csv)) });
}

/** Bulk-import the (mapped) CSV — good rows imported, bad rows reported. */
export function useImportItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (csv: string) => unwrap<any>(vendorApi.importItems(csv)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}
