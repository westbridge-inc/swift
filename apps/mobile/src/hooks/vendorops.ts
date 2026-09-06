import { useCallback, useEffect, useMemo, useState } from 'react';
import { Vibration } from 'react-native';
import { useMutation, useQuery, useQueryClient, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';
import { vendorApi, vendorDiscoveryApi } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { useVendorPreview } from '../stores/vendorPreview';
import { vendorPreviewDataset, previewQuery, previewMutation, type VendorPreviewDataset } from '../lib/vendorPreviewData';
import type { AuthSessionSnapshot } from '../lib/authSession';
import {
  getAuthSessionSnapshot,
  requireAuthSessionForPrincipal,
  requireAuthSessionSnapshot,
} from '../stores/authStore';
import { classifyVendorProfile, unwrapOptionalVendorProfile } from '../lib/vendorProfile';

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

// A mutation that is a strict NO-OP in a sample preview. This enforces the
// vendor preview's read-only guarantee at the HOOK layer — the alternative is
// relying on the server to 401 an unauthenticated preview call, which leaves the
// invariant one dropped `disabled` prop away from firing a real write. Real and
// legacy pending-peek sessions (pv === null) get the live mutation, unchanged.
// usePreviewDataset() is called unconditionally so hook order stays stable.
function usePreviewSafeMutation<TData = unknown, TError = unknown, TVars = void, TCtx = unknown>(
  options: UseMutationOptions<TData, TError, TVars, TCtx>,
): UseMutationResult<TData, TError, TVars, TCtx> {
  const pv = usePreviewDataset();
  const m = useMutation(options);
  return (pv ? previewMutation() : m) as UseMutationResult<TData, TError, TVars, TCtx>;
}

/** The stores this account works in; `store` is the selected one and
 *  `myRole` is OWNER / MANAGER / STAFF (drives which tools the UI shows). */
export function useVendorProfile() {
  const pv = usePreviewDataset();
  const q = useQuery({
    // [MOB-038] Absence is a 404 and nothing else. This used to run through a
    // helper that turned EVERY failure into null, and the shell read null as
    // "you have no business" — so an outage offered a working restaurant the
    // setup wizard while its orders were live.
    queryKey: ['vendor', 'profile'],
    queryFn: () => unwrapOptionalVendorProfile<any>(vendorApi.profile()),
    retry: false,
    refetchInterval: 20000,
    enabled: !pv,
  });
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  if (pv) {
    return {
      owner: pv.owner, store: pv.store, stores: pv.stores, myRole: 'OWNER' as const,
      isLoading: false, state: 'ready' as const, failure: undefined, refetch: () => {},
    };
  }
  const owner: any = q.data ?? null;
  const verdict = classifyVendorProfile({ isLoading: q.isLoading, error: q.error, owner, fetched: q.isFetched });
  const stores: any[] = Array.isArray(owner?.vendors) ? owner.vendors : [];
  const store: any = stores.find((v) => v.id === selectedStoreId) ?? stores[0] ?? null;
  return {
    owner,
    store,
    stores,
    // [MOB-038] The role the SERVER named, or undefined. It used to default to
    // OWNER, so an outage did not merely hide the business — it handed
    // whoever was looking owner capability over it.
    myRole: verdict.myRole,
    isLoading: q.isLoading,
    state: verdict.state,
    failure: verdict.failure,
    refetch: () => { void q.refetch(); },
  };
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
  return usePreviewSafeMutation({
    mutationFn: ({ id, response }: { id: string; response: string }) => unwrap(vendorApi.respondReview(id, response)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'reviews'] }),
  });
}

/** Movement R9: the store's daily-folded Standing view (RAT-G). */
/**
 * [MKT G3] THE CATEGORY-SUGGESTION QUEUE — the last step before a market tag.
 *
 * The backfill proposes categories for a store's items and notifies the owner
 * to review them; ACCEPTING one is what actually writes the
 * `ItemDiscoveryCategory` row the market feed filters on. Measured before this
 * shipped: 50 suggestions PENDING, 0 tags — the notification asked vendors to
 * review, the API could accept, and nothing in the app could call it.
 *
 * Machines never re-touch resolved ground, so a dismissal is as meaningful as
 * an acceptance and both are final.
 */
export function useCategorySuggestions() {
  const pv = usePreviewDataset();
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  return useQuery({
    queryKey: ['vendor', 'category-suggestions', selectedStoreId ?? null],
    queryFn: () => tryUnwrap(vendorDiscoveryApi.suggestions(getAuthSessionSnapshot() ?? undefined, selectedStoreId)),
    enabled: !pv,
    retry: false,
  });
}

export function useResolveCategorySuggestion() {
  const qc = useQueryClient();
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  // Preview-safe by law: a demo dataset must never write a real tag onto a real
  // catalogue. Every vendor mutation goes through this helper, and a gate
  // enforces it — calling `useMutation` here directly is how preview stops
  // being read-only.
  return usePreviewSafeMutation({
    mutationFn: ({ id, action }: { id: string; action: 'accept' | 'dismiss' }) =>
      tryUnwrap(vendorDiscoveryApi.resolve(id, action, getAuthSessionSnapshot() ?? undefined, selectedStoreId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendor', 'category-suggestions'] });
      // An accepted tag changes what the market feed returns for this store.
      qc.invalidateQueries({ queryKey: ['market', 'items'] });
    },
  });
}

export function useVendorStanding<T = any>() {
  const pv = usePreviewDataset();
  const q = useQuery<T>({ queryKey: ['vendor', 'standing'], queryFn: () => unwrap<T>(vendorApi.standing()), enabled: !pv });
  return pv ? previewQuery(null as T) : q;
}

/** Movement R9: which items earn the 👎 — last 30 days, worst first. */
export function useVendorItemFeedback() {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'item-feedback'],
    queryFn: () => unwrap<Array<{ itemId: string; name: string; up: number; down: number }>>(vendorApi.itemFeedback()),
    enabled: !pv,
  });
  return pv ? previewQuery([] as Array<{ itemId: string; name: string; up: number; down: number }>) : q;
}

// ─── Promotions (manager+) ───────────────────────────────────────────────────

export function useVendorPromos(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({ queryKey: ['vendor', 'promos'], queryFn: () => unwrap<any[]>(vendorApi.promos()), enabled: enabled && !pv });
  return pv ? previewQuery([] as any[]) : q;
}

export function useCreatePromo() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (data: Parameters<typeof vendorApi.createPromo>[0]) => unwrap(vendorApi.createPromo(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'promos'] }),
  });
}

export function useUpdatePromo() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: ({ id, data }: { id: string; data: { isActive?: boolean; validUntil?: string } }) =>
      unwrap(vendorApi.updatePromo(id, data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'promos'] }),
  });
}

export function useDeletePromo() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
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

/** [ALG-34] A staff grant is a money-adjacent surface: the caller passes the
 *  step-up wrapper (useStepUp().withStepUp) so a 403 STEP_UP_REQUIRED runs
 *  the code sheet and retries once. */
export type MutationGuard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A) => Promise<R>;
const passThrough: MutationGuard = (fn) => fn;

export function useAddStaff(guard: MutationGuard = passThrough) {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: guard((data: { phone: string; role: 'MANAGER' | 'STAFF' }) => unwrap(vendorApi.addStaff(data))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'staff'] }),
  });
}

export function useRemoveStaff() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (id: string) => unwrap(vendorApi.removeStaff(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'staff'] }),
  });
}

export function useUpdateStaffRole(guard: MutationGuard = passThrough) {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: guard(({ id, role }: { id: string; role: 'MANAGER' | 'STAFF' }) => unwrap(vendorApi.updateStaff(id, role))),
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
    // Scheduling liveness nudge (spec 2.6): calendar + picker refetch the
    // moment a booking is made, moved or cancelled; the poll stays the floor.
    const refreshBookings = () => qc.invalidateQueries({ queryKey: ['vendor', 'bookings'] });
    s.on('bookings:changed', refreshBookings);
    return () => {
      s.off('connect', join);
      s.off('order:new', onNew);
      s.off('order:status_changed', refresh);
      s.off('order:prep_update', refresh);
      s.off('bookings:changed', refreshBookings);
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
  return usePreviewSafeMutation({
    mutationFn: (id: string) => unwrap(vendorApi.retryDispatch(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
}

export function useToggleOpen() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({ mutationFn: () => unwrap(vendorApi.toggleOpen()), onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }) });
}
export function useToggleOrders() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({ mutationFn: () => unwrap(vendorApi.toggleOrders()), onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }) });
}
/** Turn self-delivery on/off. When on, the server routes this store's delivery
 *  orders to VENDOR_DELIVERY (the vendor delivers) instead of dispatching a rider. */
export function useSetSelfDelivery() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (selfDeliveryEnabled: boolean) => unwrap(vendorApi.updateProfile({ selfDeliveryEnabled })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }),
  });
}

export function useOrderAction() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: ({
      id,
      action,
      code,
      reason,
    }: {
      id: string;
      action: 'accept' | 'preparing' | 'ready' | 'reject' | 'complete-pickup' | 'complete-appointment' | 'confirm-payment';
      code?: string;
      /** reject only — the server records it and tells the customer why. */
      reason?: string;
    }) => {
      if (action === 'accept') return unwrap(vendorApi.acceptOrder(id));
      if (action === 'confirm-payment') return unwrap(vendorApi.confirmPayment(id, code ?? ''));
      if (action === 'preparing') return unwrap(vendorApi.preparing(id));
      if (action === 'ready') return unwrap(vendorApi.ready(id));
      if (action === 'complete-pickup') return unwrap(vendorApi.completePickup(id, code));
      if (action === 'complete-appointment') return unwrap(vendorApi.completeAppointment(id));
      return unwrap(vendorApi.reject(id, reason));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
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
  return usePreviewSafeMutation({
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
  const setPicked = usePreviewSafeMutation({
    mutationFn: ({ orderId, lineId, picked }: { orderId: string; lineId: string; picked: boolean }) =>
      unwrap(vendorApi.setLinePicked(orderId, lineId, picked)),
    onSuccess: (_d, v) => invalidate(v.orderId),
  });
  const substitute = usePreviewSafeMutation({
    mutationFn: ({ orderId, lineId, substituteItemId }: { orderId: string; lineId: string; substituteItemId: string }) =>
      unwrap(vendorApi.proposeSubstitution(orderId, lineId, substituteItemId)),
    onSuccess: (_d, v) => invalidate(v.orderId),
  });
  const refundLine = usePreviewSafeMutation({
    mutationFn: ({ orderId, lineId }: { orderId: string; lineId: string }) =>
      unwrap(vendorApi.refundLine(orderId, lineId)),
    onSuccess: (_d, v) => invalidate(v.orderId),
  });
  return { setPicked, substitute, refundLine };
}

// ─── Menu ────────────────────────────────────────────────────────────────────

/** Categories with their nested items (the menu, grouped by section). */
export function useVendorMenu(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({ queryKey: ['vendor', 'menu'], queryFn: () => unwrap<any[]>(vendorApi.categories()), enabled: enabled && !pv });
  return pv ? previewQuery(pv.menu.categories) : q;
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (data: { name: string }) => unwrap(vendorApi.createCategory(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string } }) => unwrap(vendorApi.updateCategory(id, data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

/** Deleting a category removes its items too — the UI must confirm with the count. */
export function useDeleteCategory() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deleteCategory(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

/** Create (no id) or update (id present) an item. */
export function useSaveItem() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: ({ id, data, authSession, storeId }: {
      id?: string;
      data: any;
      authSession?: AuthSessionSnapshot;
      storeId?: string | null;
    }) =>
      id
        ? unwrap(vendorApi.updateItem(id, data, authSession, storeId))
        : unwrap(vendorApi.createItem(data, authSession, storeId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deleteItem(id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useSetItemAvailability() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
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
  return usePreviewSafeMutation({
    mutationFn: ({ itemId, data, authSession }: {
      itemId: string;
      data: { name: string; isRequired?: boolean; minSelect?: number; maxSelect?: number };
      authSession?: AuthSessionSnapshot;
    }) => unwrap<any>(vendorApi.addOptionGroup(itemId, data, authSession)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useDeleteOptionGroup() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (input: string | { id: string; authSession?: AuthSessionSnapshot }) => {
      const id = typeof input === 'string' ? input : input.id;
      const authSession = typeof input === 'string' ? undefined : input.authSession;
      return unwrap(vendorApi.deleteOptionGroup(id, authSession));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useAddOption() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: ({ groupId, data, authSession }: {
      groupId: string;
      data: { name: string; additionalPrice?: number };
      authSession?: AuthSessionSnapshot;
    }) => unwrap<any>(vendorApi.addOption(groupId, data, authSession)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

export function useDeleteOption() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (input: string | { id: string; authSession?: AuthSessionSnapshot }) => {
      const id = typeof input === 'string' ? input : input.id;
      const authSession = typeof input === 'string' ? undefined : input.authSession;
      return unwrap(vendorApi.deleteOption(id, authSession));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

/** Upload (or replace) an item's photo — multipart to the StorageProvider. */
export function useUploadItemImage() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: ({ id, file, authSession, storeId }: {
      id: string;
      file: { uri: string; name: string; type: string };
      authSession?: AuthSessionSnapshot;
      storeId?: string | null;
    }) => {
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
      return unwrap(vendorApi.uploadItemImage(id, form, authSession, storeId));
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

/** Loyalty: customers with >=2 finished orders here + the repeat rate. Read on
 *  the MANAGER-only Insights tab (the endpoint requires MANAGER). */
export function useRepeatCustomers() {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'analytics', 'repeat-customers'],
    queryFn: () => unwrap<any>(vendorApi.analyticsRepeatCustomers()),
    enabled: !pv,
  });
  return pv ? previewQuery(pv.loyalty) : q;
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

export type VendorQrPayload = {
  deepLink: string;
  shortUrl: string;
  shortCode: string;
  canonicalUrl: string;
  version: number;
  status: string;
  graceDays: number;
  svg: string;
  vendorName: string;
};

/** Storefront QR + short link (manager+). Changes only on regenerate/deactivate
 *  — cache hard; the lifecycle mutations invalidate. */
export function useVendorQr(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'qr'],
    queryFn: () => unwrap<VendorQrPayload>(vendorApi.qr()),
    enabled: enabled && !pv,
    staleTime: Infinity,
  });
  return pv ? previewQuery(null) : q;
}

export type QrAnalytics = {
  range: '7d' | '30d' | '90d' | 'all';
  totals: {
    scans: number;
    approxUniqueScanners: number;
    storeViews: number;
    webOrders: number;
    appOpens: number;
    installTaps: number;
    installsAttributed: number;
    attributedFirstOrders: number;
  };
  funnel: { stage: string; count: number }[];
  byDay: { date: string; scans: number; webOrders: number }[];
  byTemplate: { template: string; scans: number }[];
};

/** The performance card — server truth, reconciles to rows by test-gate. */
export function useVendorQrAnalytics(range: QrAnalytics['range']) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'qr-analytics', range],
    queryFn: () => unwrap<QrAnalytics>(vendorApi.qrAnalytics(range)),
    enabled: !pv,
    staleTime: 60_000,
  });
  return pv ? previewQuery(null) : q;
}

/** Owner-only: supersede the current code (grace window) and mint the next. */
export function useRegenerateQr() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: () => unwrap<VendorQrPayload & { previous: { shortCode: string; graceDays: number; graceEndsAt: string } | null }>(vendorApi.qrRegenerate()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'qr'] });
      void qc.invalidateQueries({ queryKey: ['vendor', 'qr-analytics'] });
    },
  });
}

/** Owner-only kill switch — immediate. */
export function useDeactivateQr() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: () => unwrap<{ deactivated: boolean }>(vendorApi.qrDeactivate()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'qr'] });
    },
  });
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

export type VendorBookingException = {
  id: string;
  itemId: string | null;
  date: string;
  start: string | null;
  end: string | null;
  reason: string | null;
};

/** Blocked time in the coming month — renders hatched on the day calendar. */
export function useVendorBookingExceptions(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery<VendorBookingException[]>({
    queryKey: ['vendor', 'booking-exceptions'],
    queryFn: () => unwrap<VendorBookingException[]>(vendorApi.bookingExceptions()),
    enabled: enabled && !pv,
    staleTime: 30_000,
  });
  return pv ? previewQuery([] as VendorBookingException[]) : q;
}

/** Block time — "funeral afternoon in two taps" (scheduling 2.1). */
export function useCreateBookingException() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (data: { date: string; start?: string; end?: string; reason?: string }) =>
      unwrap(vendorApi.createBookingException(data)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'booking-exceptions'] });
      void qc.invalidateQueries({ queryKey: ['vendor', 'bookings'] });
    },
  });
}

export function useDeleteBookingException() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (id: string) => unwrap(vendorApi.deleteBookingException(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'booking-exceptions'] });
      void qc.invalidateQueries({ queryKey: ['vendor', 'bookings'] });
    },
  });
}

export function useSetHours() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
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
  return usePreviewSafeMutation({
    mutationFn: async ({ kind, file, authSession, storeId }: {
      kind: 'xlsx' | 'menu-pdf';
      file: { uri: string; name: string; type: string };
      authSession?: AuthSessionSnapshot;
      storeId?: string | null;
    }) => {
      const owner = authSession ?? requireAuthSessionSnapshot();
      const current = requireAuthSessionForPrincipal(owner);
      const form = new FormData();
      form.append('file', file as unknown as Blob);
      const result = await unwrap<any>(kind === 'xlsx'
        ? vendorApi.importXlsx(form, current, storeId)
        : vendorApi.importMenuPdf(form, current, storeId));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
  });
}

export function useImportAutomap() {
  return usePreviewSafeMutation({
    mutationFn: async (input: string | {
      csv: string;
      authSession?: AuthSessionSnapshot;
      storeId?: string | null;
    }) => {
      const csv = typeof input === 'string' ? input : input.csv;
      const owner = typeof input === 'string'
        ? requireAuthSessionSnapshot()
        : input.authSession ?? requireAuthSessionSnapshot();
      const storeId = typeof input === 'string' ? undefined : input.storeId;
      const current = requireAuthSessionForPrincipal(owner);
      const result = await unwrap<any>(vendorApi.importAutomap(csv, current, storeId));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
  });
}

/** Bulk-import the (mapped) CSV — good rows imported, bad rows reported. */
export function useImportItems() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: async (input: string | {
      csv: string;
      authSession?: AuthSessionSnapshot;
      storeId?: string | null;
    }) => {
      const csv = typeof input === 'string' ? input : input.csv;
      const owner = typeof input === 'string'
        ? requireAuthSessionSnapshot()
        : input.authSession ?? requireAuthSessionSnapshot();
      const storeId = typeof input === 'string' ? undefined : input.storeId;
      const current = requireAuthSessionForPrincipal(owner);
      const result = await unwrap<any>(vendorApi.importItems(csv, current, storeId));
      requireAuthSessionForPrincipal(owner);
      return result;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'menu'] }),
  });
}

/** [DOC-1 §3.6 · P3-2] The store's tier — caps, today's and this week's usage, what lifts the limits. */
export function useVendorTier<T = any>() {
  const pv = usePreviewDataset();
  return useQuery<T>({
    queryKey: ['vendor', 'tier'],
    queryFn: async () => (await vendorApi.tier()).data?.data as T,
    enabled: !pv,
    refetchInterval: 60000,
  });
}

