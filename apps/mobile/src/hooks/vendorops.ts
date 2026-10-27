import { POLL } from '../lib/pollPolicy';
import { prepareUploadImage } from '../lib/uploadImage';
import { bindVendorOrderFeed } from '../lib/vendorOrderFeed';
import { runBillingMutation } from '../lib/billingMutation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Vibration } from 'react-native';
import { useMutationState, useQuery, useQueryClient, type QueryClient, type UseMutationOptions, type UseMutationResult } from '@tanstack/react-query';
import { vendorApi, vendorDiscoveryApi } from '../services/api';
import { connectSocket, getSocket } from '../services/socket';
import { useStoreSwitcher } from '../stores/storeSwitcher';
import { useVendorPreview } from '../stores/vendorPreview';
import {
  vendorPreviewDataset,
  vendorPreviewSubscription,
  previewQuery,
  previewMutation,
  VENDOR_PREVIEW_MARKET,
  type VendorPreviewDataset,
} from '../lib/vendorPreviewData';
import type { AuthSessionSnapshot } from '../lib/authSession';
import {
  getAuthSessionSnapshot,
  requireAuthSessionForPrincipal,
  newCommandKey,
  requireAuthSessionSnapshot,
  useAuthStore,
} from '../stores/authStore';
import { accountHoldsRole } from '../lib/roleLanding';
import { classifyVendorProfile, unwrapOptionalVendorProfile } from '../lib/vendorProfile';
import { withStoreFields, withStoreSwitchAnswer, type StoreSwitchAnswer } from '../lib/storeOpenSwitch';
import {
  MENU_REREAD_SETTLE_MS, menuWithItem, menuWithItemFields, menuWithOption, menuWithOptionGroup, menuWithSection,
  menuWithoutItem, menuWithoutOption, menuWithoutOptionGroup, menuWithoutSection,
} from '../lib/menuAnswers';
import { confirmVendorCashSettlement } from './cashSettlement';
import { usePartnerPricing } from './partnerPricing';
import { guardVendorOperation, useVendorMutation } from './useVendorMutation';
import { pendingOrderIds } from '../modules/vendor/boardTaps';
import { answeredSinceAsked } from '../modules/vendor/storeOrderRules';
import { errorMessage } from '../lib/apiError';
import type { SaleAnswer, SaleOp } from '../lib/inStoreSale';
import { phoneSaleFailure, soldInStore } from './useSoldInStore';

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
  const m = useVendorMutation(options);
  return (pv ? previewMutation() : m) as UseMutationResult<TData, TError, TVars, TCtx>;
}

/** The stores this account works in; `store` is the selected one and
 *  `myRole` is OWNER / MANAGER / STAFF (drives which tools the UI shows). */
export function useVendorProfile() {
  const pv = usePreviewDataset();
  // A customer who tapped "Swift Business" to list a first store holds no
  // vendor role yet. The server's 403 on their own profile read is then the
  // confirmation of "no business" that routes them to the setup wizard (the
  // JOIN flow), not a permission error. The same predicate decides "Join" in
  // the switcher, so the two screens can never disagree.
  const outsider = useAuthStore((s) => !accountHoldsRole(s.user as Parameters<typeof accountHoldsRole>[0], 'vendor'));
  const q = useQuery({
    // [MOB-038] Absence is a 404 and nothing else — or a 403 for an account
    // that holds no vendor role (lib/vendorProfile). This used to run through
    // a helper that turned EVERY failure into null, and the shell read null as
    // "you have no business" — so an outage offered a working restaurant the
    // setup wizard while its orders were live.
    queryKey: ['vendor', 'profile'],
    queryFn: () => unwrapOptionalVendorProfile<any>(vendorApi.profile(), { outsider }),
    retry: false,
    refetchInterval: POLL.vendorProfile,
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
    mutationFn: guard(guardVendorOperation((data: { phone: string; role: 'MANAGER' | 'STAFF' }) => unwrap(vendorApi.addStaff(data)))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'staff'] }),
  });
}

/** [Row 55] Withdraw every unanswered team invite (nothing pending is listed). */
export function useWithdrawStaffInvites() {
  return usePreviewSafeMutation({
    mutationFn: () => unwrap<{ withdrawn: boolean; message?: string }>(vendorApi.withdrawStaffInvites()),
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
    mutationFn: guard(guardVendorOperation(({ id, role }: { id: string; role: 'MANAGER' | 'STAFF' }) => unwrap(vendorApi.updateStaff(id, role)))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'staff'] }),
  });
}

export function useVendorOrders(enabled: boolean) {
  const pv = usePreviewDataset();
  const q = useQuery({
    queryKey: ['vendor', 'orders'],
    queryFn: () => unwrap(vendorApi.orders()),
    enabled: enabled && !pv,
    refetchInterval: () => enabled && !pv ? POLL.vendorOrders() : false,
  });
  return pv ? previewQuery(pv.orders) : q;
}

/** Live board: join the store's socket room and refresh the order queries the
 *  moment the server says something happened (new order, status change, prep
 *  signal) instead of waiting out the 12s poll — the poll stays as the
 *  reconnect safety net. A new order also buzzes the phone: the board is a
 *  counter appliance, not a screen someone stares at. */
/** `ownsStore`: the server admits only the store owner to the store room. */
export function useVendorOrdersLive(vendorId: string | undefined, ownsStore = false) {
  const qc = useQueryClient();
  const previewType = useVendorPreview((s) => s.previewType);
  // NEW-ORDER takeover queue (alerts spec §A1): every order:new lands here;
  // the takeover component works it FIFO and dismisses per order.
  const [takeover, setTakeover] = useState<Array<{ orderId: string; orderNumber?: string }>>([]);
  useEffect(() => {
    if (!vendorId || previewType) return; // preview: no socket, no live buzz
    connectSocket();
    const s = getSocket();
    // Only the selected store's layer may (re)join its room: a store handoff
    // reconnects the shared socket, and a retired layer's handler can run
    // before React unmounts it.
    const onNew = (payload?: { orderId?: string; orderNumber?: string }) => {
      Vibration.vibrate(400);
      if (payload?.orderId) {
        setTakeover((q) =>
          q.some((x) => x.orderId === payload.orderId)
            ? q
            : [...q, { orderId: payload.orderId!, orderNumber: payload.orderNumber }],
        );
      }
      qc.invalidateQueries({ queryKey: ['vendor', 'orders'] });
    };
    // Scheduling liveness nudge (spec 2.6): calendar + picker refetch the
    // moment a booking is made, moved or cancelled; the poll stays the floor.
    return bindVendorOrderFeed(s, vendorId, () => useStoreSwitcher.getState().selectedStoreId === vendorId, {
      onNew,
      refresh: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
      refreshBookings: () => qc.invalidateQueries({ queryKey: ['vendor', 'bookings'] }),
      refreshOverview: () => qc.invalidateQueries({ queryKey: ['vendor', 'analytics'] }),
    }, { serverAdmits: ownsStore });
  }, [vendorId, ownsStore, qc, previewType]);

  // [STORE-DASH · REVIEW-F S3-1 on #2048] The customer answered the store's "Out of stock" question:
  // the server sends no push (only order:pick_state, which re-reads the board) and the store's response
  // clock restarts from the answer. Watch the board: an order that was waiting on the customer and is
  // the store's decision again takes the new-order screen again (as the web popup does).
  const askedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!vendorId || previewType) return;
    const check = () => {
      const { answered, deciding } = answeredSinceAsked(askedRef.current, qc.getQueryData(['vendor', 'orders']));
      askedRef.current = deciding;
      if (answered.length === 0) return;
      Vibration.vibrate(400);
      // The takeover opens on the board's fresh copy (useVendorOrder's placeholder), never on a
      // stale copy of the order that still shows the question (which would settle it at once).
      for (const a of answered) qc.removeQueries({ queryKey: ['vendor', 'orders', 'detail', a.orderId], exact: true });
      setTakeover((q) => [...q, ...answered.filter((a) => !q.some((x) => x.orderId === a.orderId))]);
    };
    check();
    return qc.getQueryCache().subscribe((event) => {
      const key = event?.query?.queryKey;
      if (event?.type === 'updated' && Array.isArray(key) && key.length === 2 && key[0] === 'vendor' && key[1] === 'orders') check();
    });
  }, [vendorId, previewType, qc]);

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
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['vendor', 'orders', 'detail', id],
    queryFn: () => unwrap<any>(vendorApi.order(id!)),
    enabled: !!id && !pv,
    refetchInterval: POLL.vendorOrder,
    // [STORE-DASH] The order opens at once from the board's own copy of it; the
    // order's own read replaces it the moment it answers (isPlaceholderData).
    placeholderData: () => boardOrder(qc.getQueryData(['vendor', 'orders']), id),
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
  const storeId = useStoreSwitcher((s) => s.selectedStoreId);
  const principal = useAuthStore((s) => s.user?.id);
  const generation = useAuthStore((s) => s.sessionGeneration);
  const q = useQuery({ queryKey: ['vendor', 'subscription', storeId, principal, generation], queryFn: async () => {
    const session = requireAuthSessionSnapshot();
    const sub = await unwrap(vendorApi.subscription(session, storeId));
    const current = getAuthSessionSnapshot();
    if (current?.userId !== session.userId || current?.generation !== session.generation || useStoreSwitcher.getState().selectedStoreId !== storeId) throw new Error('The paying account changed.');
    return sub;
  }, enabled: enabled && !pv });
  // Preview bills the sample store the live quote for its business type — the
  // public price list, read only in preview — never a number frozen in the app.
  const pricing = usePartnerPricing(VENDOR_PREVIEW_MARKET, !!pv);
  const sample = useMemo(() => (pv ? vendorPreviewSubscription(pv, pricing.data) : null), [pv, pricing.data]);
  if (!pv) return q;
  // [H7] While the price list is still loading or has failed, the preview
  // query says so and the screen shows its own loading or error state — never
  // a sample store with no fee, which read as "nothing due, you are covered".
  return {
    ...previewQuery(sample),
    isLoading: sample == null && pricing.isPending === true,
    isError: sample == null && pricing.isError === true,
    refetch: pricing.refetch,
  };
}

/** [E12] Stop (NONE) or resume (CASH / MOBILE_MONEY) the weekly fee, then
 *  re-read the subscription so the screen's autoRenew state is server truth. */
export function useSetVendorBillingMethod(guard: MutationGuard) {
  const qc = useQueryClient();
  // [DS198 D4] Preview-safe like every other vendor write: in the sample
  // preview, "Stop weekly billing" must never fire a real PUT.
  return usePreviewSafeMutation({
    mutationFn: ({ method, mmgPayerMsisdn }: { method: 'CASH' | 'MOBILE_MONEY' | 'NONE'; mmgPayerMsisdn?: string }) => {
      return runBillingMutation(guard,
        (session, storeId) => unwrap(vendorApi.setBillingMethod(method, mmgPayerMsisdn, session, storeId)),
        () => useStoreSwitcher.getState().selectedStoreId);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['vendor', 'subscription'] }),
  });
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

/** [AF-MOB-006] The store confirms a returned order is back. The server closes
 *  the return (and its recovery case); both order reads are refreshed. */
export function useReturnReceived() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (id: string) => unwrap(vendorApi.returnReceived(id)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
}

/** The server owns custody. This only records the eligible store's requested
 * delivery owner and immediately re-reads both its detail and every order list
 * after a success or a race refusal. */
export function useSetOrderFulfillmentMode() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'PLATFORM_RIDER' | 'VENDOR_DELIVERY' }) =>
      unwrap(vendorApi.setFulfillmentMode(id, mode)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
}

/** [PERF row 562] lib/storeOpenSwitch: the screen shows the tapped state while
 *  this is out; the server's answer (both flags) goes into the store at once and
 *  the re-read runs on its own. An answer it cannot place keeps the switch on
 *  the tapped state until the re-read (the old wait); a failure re-reads too, so
 *  the switch goes back to what the server holds. */
export function useToggleOpen() {
  const qc = useQueryClient();
  const reread = () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
  return usePreviewSafeMutation({
    mutationFn: (open: boolean) => unwrap(vendorApi.toggleOpen(open)),
    // The store this request is for: the header carries the selected store, and
    // a store switch before the send refuses it (useVendorMutation).
    onMutate: () => useStoreSwitcher.getState().selectedStoreId ?? null,
    onSuccess: (answer: StoreSwitchAnswer, _open: boolean, storeId: string | null | undefined) => {
      const before = qc.getQueryData(['vendor', 'profile']);
      const after = withStoreSwitchAnswer(before, storeId, answer);
      if (after === before) return reread();
      qc.setQueryData(['vendor', 'profile'], after);
      void reread();
      return undefined;
    },
    onError: () => { void reread(); },
  });
}
/** [TAP-AUDIT] Pause / resume new orders answers at the tap, as Store open does (PERF row 562): the screen shows the
 *  tapped state while the request is out (shownStoreOpen), the server's own answer (both flags) goes into the store at
 *  once, and the re-read runs on its own. A refusal re-reads, so the button shows what the server holds. */
export function useToggleOrders() {
  const qc = useQueryClient();
  const reread = () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
  return usePreviewSafeMutation({
    mutationFn: (accepting: boolean) => unwrap(vendorApi.toggleOrders(accepting)),
    onMutate: () => useStoreSwitcher.getState().selectedStoreId ?? null,
    onSuccess: (answer: StoreSwitchAnswer, _accepting: boolean, storeId: string | null | undefined) => {
      const before = qc.getQueryData(['vendor', 'profile']);
      const after = withStoreSwitchAnswer(before, storeId, answer);
      if (after !== before) qc.setQueryData(['vendor', 'profile'], after);
      void reread();
    },
    onError: () => { void reread(); },
  });
}
/** [TAP-AUDIT] A store setting switch answers at the tap: the tapped state shows while the request is out, the saved
 *  store's own value goes into the profile at once, and the re-reads run on their own (they used to hold the switch
 *  until a second round trip). */
function settingSwitchAnswers(qc: ReturnType<typeof useQueryClient>, field: 'requirePickupCode' | 'selfDeliveryEnabled', reread: () => void) {
  return {
    onMutate: () => useStoreSwitcher.getState().selectedStoreId ?? null,
    onSuccess: (answer: unknown, _on: boolean, storeId: string | null | undefined) => {
      const before = qc.getQueryData(['vendor', 'profile']);
      const after = withStoreFields(before, storeId, answer, [field]);
      if (after !== before) qc.setQueryData(['vendor', 'profile'], after);
      reread();
    },
    onError: () => { reread(); },
  };
}
/** [STORE-DASH · O-2] The store's "Ask for the pickup code" setting (owner/manager; rides the store profile). */
export function useSetRequirePickupCode() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (requirePickupCode: boolean) => unwrap(vendorApi.updateProfile({ requirePickupCode })),
    // The orders carry pickupCodeRequired: re-read them too, so the cards switch with the setting.
    ...settingSwitchAnswers(qc, 'requirePickupCode', () => {
      void qc.invalidateQueries({ queryKey: ['vendor', 'profile'] });
      void qc.invalidateQueries({ queryKey: ['vendor', 'orders'] });
    }),
  });
}

/** Turn self-delivery on/off. When on, the server routes this store's delivery
 *  orders to VENDOR_DELIVERY (the vendor delivers) instead of dispatching a rider. */
export function useSetSelfDelivery() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationFn: (selfDeliveryEnabled: boolean) => unwrap(vendorApi.updateProfile({ selfDeliveryEnabled })),
    ...settingSwitchAnswers(qc, 'selfDeliveryEnabled', () => { void qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }); }),
  });
}

/** [STORE-DASH] Every store tap on an order shares this key, so the board can
 *  tell WHICH orders are waiting for the server (usePendingOrderIds). */
export const ORDER_ACTION_KEY = ['vendor', 'order-action'] as const;

/** The board copy of one order, when the board holds it. */
export function boardOrder(board: unknown, id: string | undefined): any {
  if (!id || !Array.isArray(board)) return undefined;
  return board.find((o) => o?.id === id) ?? undefined;
}

/** [STORE-DASH] The orders whose store tap is still out: only those cards wait. */
export function usePendingOrderIds(): ReadonlySet<string> {
  const variables = useMutationState({
    filters: { mutationKey: ORDER_ACTION_KEY, status: 'pending' },
    select: (m) => m.state.variables,
  });
  return useMemo(() => pendingOrderIds(variables), [variables]);
}

export function useOrderAction() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: ORDER_ACTION_KEY,
    mutationFn: ({
      id,
      action,
      code,
      reason,
    }: {
      id: string;
      action: 'accept' | 'preparing' | 'ready' | 'delivered' | 'reject' | 'complete-pickup' | 'complete-appointment' | 'confirm-payment' | 'handed-to-rider' | 'handed-to-customer';
      code?: string;
      /** reject only — the server records it and tells the customer why. */
      reason?: string;
    }) => {
      if (action === 'accept') return unwrap(vendorApi.acceptOrder(id));
      if (action === 'confirm-payment') return unwrap(vendorApi.confirmPayment(id, code ?? ''));
      if (action === 'preparing') return unwrap(vendorApi.preparing(id));
      if (action === 'ready') return unwrap(vendorApi.ready(id));
      if (action === 'delivered') return unwrap(vendorApi.delivered(id));
      if (action === 'complete-pickup') return unwrap(vendorApi.completePickup(id, code));
      // [STORE-DASH · O-2] The store's pickup code is off: no code is sent (the server completes the hand-over).
      if (action === 'handed-to-customer') return unwrap(vendorApi.completePickup(id));
      if (action === 'handed-to-rider') return unwrap(vendorApi.handedToRider(id));
      if (action === 'complete-appointment') return unwrap(vendorApi.completeAppointment(id));
      // [E10] Never send a bare rejection: the API refuses it, and the customer
      // must be told why. Every screen collects a preset before it gets here.
      if (!reason?.trim()) throw new Error('Pick a reason before rejecting.');
      return unwrap(vendorApi.reject(id, reason));
    },
    // [PERF row 562] The server's confirmed answer lands at once: its status and clocks go into the
    // order and the board right away, and the re-read runs on its own. The tap used to stay busy
    // until that re-read came back (one more round trip). Nothing shows before the answer: dispatch
    // and money never show success early.
    onSuccess: (answer, vars) => {
      applyConfirmedOrder(qc, vars.id, answer);
      void qc.invalidateQueries({ queryKey: ['vendor', 'orders'] });
    },
  });
}

/** [PERF row 562] What a store tap's answer confirms about its order (status and its clocks). */
const CONFIRMED_ORDER_FIELDS = ['status', 'acceptedAt', 'preparingAt', 'readyAt', 'estimatedPrepTime', 'deliveredAt', 'completedAt', 'cancelledAt', 'handedToRiderAt'] as const;

/** Writes the confirmed fields of a tap's answer into the order's caches, when the answer is that order. */
export function applyConfirmedOrder(qc: Pick<ReturnType<typeof useQueryClient>, 'setQueryData'>, id: string, answer: unknown): boolean {
  const row = answer as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== 'object' || row['id'] !== id || typeof row['status'] !== 'string') return false;
  const confirmed = Object.fromEntries(CONFIRMED_ORDER_FIELDS.filter((key) => key in row).map((key) => [key, row[key]]));
  qc.setQueryData(['vendor', 'orders', 'detail', id], (order: any) => (order ? { ...order, ...confirmed } : order));
  qc.setQueryData(['vendor', 'orders'], (orders: any) => (Array.isArray(orders) ? orders.map((o) => (o?.id === id ? { ...o, ...confirmed } : o)) : orders));
  return true;
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
    mutationFn: confirmVendorCashSettlement,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'cash-settlements'] }),
  });
}

/** [REVIEW-F #2143 S3-2] What a refused pick tick says: the server's own reason, or a plain sentence. */
export const TICK_REFUSED_TITLE = 'That tick didn’t save';
export function tickRefusalWords(error: unknown): string {
  return errorMessage(error, 'Check your connection and tap it again.');
}

/** [TAP-AUDIT] Every pick tick carries this key: the screen reads which lines are waiting (usePendingPickLines). */
export const PICK_KEY = ['vendor', 'orders', 'pick'] as const;
/** An order with one line's `picked` as given (an order without that line, or not an order, comes back as it is). */
export function withLinePicked(order: unknown, lineId: string, picked: boolean): unknown {
  const items = (order as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items) || !items.some((l) => (l as { id?: unknown } | null)?.id === lineId)) return order;
  return { ...(order as object), items: items.map((l) => ((l as { id?: unknown } | null)?.id === lineId ? { ...(l as object), picked } : l)) };
}
/** The lines of this order whose tick is still on its way to the server (each waits alone). */
export function usePendingPickLines(orderId: string | undefined): ReadonlySet<string> {
  const lines = useMutationState({
    filters: { mutationKey: PICK_KEY, status: 'pending' },
    select: (m) => m.state.variables as { orderId?: string; lineId?: string } | undefined,
  });
  return new Set(lines.filter((v) => v?.orderId === orderId).map((v) => v!.lineId!));
}

/** Grocery picking (§5.3): tick lines, swap out-of-stock, refund a line. */
export function usePickingActions() {
  const qc = useQueryClient();
  const invalidate = (orderId: string) => {
    qc.invalidateQueries({ queryKey: ['vendor', 'order', orderId] });
    qc.invalidateQueries({ queryKey: ['vendor', 'orders'] });
  };
  // [TAP-AUDIT] A pick tick shows at the tap (on the order and its board card), the server's answer is written, and
  // the order alone is read again once after the last tick. It used to wait for the write AND a re-read of every
  // vendor order query (board, every open order, history) before the box ticked: ~1.3 s a line on a mobile link.
  const writePick = (orderId: string, lineId: string, picked: boolean) => {
    qc.setQueryData(['vendor', 'orders', 'detail', orderId], (order: unknown) => withLinePicked(order, lineId, picked));
    qc.setQueryData(['vendor', 'orders'], (orders: unknown) => (Array.isArray(orders)
      ? orders.map((o: any) => (o?.id === orderId ? withLinePicked(o, lineId, picked) : o))
      : orders));
  };
  const setPicked = usePreviewSafeMutation({
    mutationKey: PICK_KEY,
    mutationFn: ({ orderId, lineId, picked }: { orderId: string; lineId: string; picked: boolean }) =>
      unwrap<{ picked?: unknown }>(vendorApi.setLinePicked(orderId, lineId, picked)),
    onMutate: async ({ orderId, lineId, picked }) => {
      // A read already on its way would land with the box as it was.
      await qc.cancelQueries({ queryKey: ['vendor', 'orders', 'detail', orderId], exact: true });
      writePick(orderId, lineId, picked);
    },
    // [REVIEW-F #2143 S3-2] A refused tick goes back WITH words, as on the web: the server's reason, or a plain
    // sentence. Said here, once (the app-wide notice stays quiet for this tap). The toast is loaded when needed.
    meta: { silent: true },
    onError: (error, { orderId, lineId, picked }) => {
      writePick(orderId, lineId, !picked);
      void import('../kit/toast').then(({ toast }) => toast.error(TICK_REFUSED_TITLE, tickRefusalWords(error)));
    },
    onSuccess: (line, { orderId, lineId }) => { if (typeof line?.picked === 'boolean') writePick(orderId, lineId, line.picked); },
    onSettled: (_d, _e, { orderId }) => {
      // Only the last tick re-reads (a re-read while another tick is out would show that box as it was).
      if (qc.isMutating({ mutationKey: PICK_KEY }) <= 1) void qc.invalidateQueries({ queryKey: ['vendor', 'orders', 'detail', orderId], exact: true });
    },
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

const MENU_KEY = ['vendor', 'menu'] as const;
/** [TAP-AUDIT] Every menu change carries this key, so the one re-read waits while any change is still on its way. */
export const MENU_WRITE_KEY = ['vendor', 'menu', 'write'] as const;
export type MenuScope = { storeId: string | null; generation: number };
/** The store a menu change is sent for (onMutate): its answer is written only while that store is still the one shown. */
export function menuScope(): MenuScope {
  const s = useStoreSwitcher.getState();
  return { storeId: s.selectedStoreId, generation: s.storeGeneration };
}
function sameMenuScope(scope: MenuScope | undefined): boolean {
  const s = useStoreSwitcher.getState();
  return !!scope && s.selectedStoreId === scope.storeId && s.storeGeneration === scope.generation;
}
const menuRereads = new WeakMap<QueryClient, ReturnType<typeof setTimeout>>();
/** [TAP-AUDIT] ONE re-read of the menu after a burst of changes (lib/menuAnswers): it waits until the changes stop
 *  and none is still on its way (a re-read then would show that change's old value for a moment). */
export function rereadMenuSoon(qc: QueryClient, delay = MENU_REREAD_SETTLE_MS): void {
  const waiting = menuRereads.get(qc);
  if (waiting) clearTimeout(waiting);
  menuRereads.set(qc, setTimeout(() => {
    menuRereads.delete(qc);
    if (qc.isMutating({ mutationKey: MENU_WRITE_KEY }) > 0) {
      rereadMenuSoon(qc, delay);
      return;
    }
    void qc.invalidateQueries({ queryKey: MENU_KEY });
  }, delay));
}
/** [TAP-AUDIT] The server's answer written into the menu on screen (for the store it was sent for), then the one
 *  re-read. Returns nothing: the button is free at the answer, not after a whole-menu download. */
export function answerIntoMenu(qc: QueryClient, scope: MenuScope | undefined, apply: (menu: unknown) => unknown): void {
  if (!sameMenuScope(scope)) return;
  if (qc.getQueryData(MENU_KEY) !== undefined) {
    // [REVIEW-G #2141 S3-1] A menu read already on its way left BEFORE this change: landing, it would put the old menu
    // back on screen (a switched-off item on again, a deleted one back) until the next re-read. It is cancelled (the
    // menu stays as the screen held it) and the answer is written; the one re-read below reads the menu again.
    void qc.cancelQueries({ queryKey: MENU_KEY, exact: true });
    qc.setQueryData(MENU_KEY, (menu: unknown) => (menu === undefined ? menu : apply(menu)));
  }
  rereadMenuSoon(qc);
}

/** Categories with their nested items (the menu, grouped by section). */
export function useVendorMenu(enabled = true) {
  const pv = usePreviewDataset();
  const q = useQuery({ queryKey: ['vendor', 'menu'], queryFn: () => unwrap<any[]>(vendorApi.categories()), enabled: enabled && !pv });
  return pv ? previewQuery(pv.menu.categories) : q;
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: (data: { name: string }) => unwrap(vendorApi.createCategory(data)),
    onMutate: menuScope,
    onSuccess: (answer, _data, scope) => answerIntoMenu(qc, scope, (menu) => menuWithSection(menu, answer)),
  });
}

export function useUpdateCategory() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: ({ id, data }: { id: string; data: { name?: string } }) => unwrap(vendorApi.updateCategory(id, data)),
    onMutate: menuScope,
    onSuccess: (answer, _vars, scope) => answerIntoMenu(qc, scope, (menu) => menuWithSection(menu, answer)),
  });
}

/** Deleting a category removes its items too — the UI must confirm with the count. */
export function useDeleteCategory() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: (id: string) => unwrap(vendorApi.deleteCategory(id)),
    onMutate: menuScope,
    onSuccess: (_answer, id, scope) => answerIntoMenu(qc, scope, (menu) => menuWithoutSection(menu, id)),
  });
}

/** Create (no id) or update (id present) an item. A new item may carry its option groups and their choices
 *  (`data.optionGroups`): the server saves them with the item, in the same request. */
export function useSaveItem() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: ({ id, data, authSession, storeId }: {
      id?: string;
      data: any;
      authSession?: AuthSessionSnapshot;
      storeId?: string | null;
    }) =>
      id
        ? unwrap(vendorApi.updateItem(id, data, authSession, storeId))
        : unwrap(vendorApi.createItem(data, authSession, storeId)),
    onMutate: menuScope,
    onSuccess: (answer, _vars, scope) => answerIntoMenu(qc, scope, (menu) => menuWithItem(menu, answer)),
  });
}

export function useDeleteItem() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: (id: string) => unwrap(vendorApi.deleteItem(id)),
    onMutate: menuScope,
    onSuccess: (_answer, id, scope) => answerIntoMenu(qc, scope, (menu) => menuWithoutItem(menu, id)),
  });
}

export function useSetItemAvailability() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: ({ id, isAvailable }: { id: string; isAvailable: boolean }) =>
      unwrap<{ isAvailable?: unknown }>(vendorApi.setItemAvailability(id, isAvailable)),
    onMutate: menuScope,
    onSuccess: (answer, { id }, scope) => answerIntoMenu(qc, scope, (menu) => (
      typeof answer?.isAvailable === 'boolean' ? menuWithItemFields(menu, id, { isAvailable: answer.isAvailable }) : menu
    )),
  });
}

// [IN-STORE-SALE] The sender for the app's "Sold in store −1" taps (hooks/useSoldInStore, lib/inStoreSale): each tap
// is one request with its own key; the server's count is written into the menu on screen (for the store it was tapped
// in) and the menu is read again once, later. Its failures show on the row in words (never the app-wide toast).
const MENU_READ_KEY = ['vendor', 'menu'] as const;
const saleFields = (answer: SaleAnswer) => ({
  ...(typeof answer?.stockQuantity === 'number' ? { stockQuantity: answer.stockQuantity } : {}),
  ...(typeof answer?.isAvailable === 'boolean' ? { isAvailable: answer.isAvailable } : {}),
});
export function useSoldInStoreSender(): { tap: (_itemId: string) => void; undo: (_itemId: string) => void; retry: (_itemId: string) => void } {
  const qc = useQueryClient();
  const session = useAuthStore((s) => s.sessionGeneration);
  const sale = useVendorMutation({
    mutationKey: MENU_WRITE_KEY,
    meta: { silent: true },
    mutationFn: ({ itemId, op }: { itemId: string; op: SaleOp }) => unwrap<SaleAnswer>(
      op.kind === 'sale' ? vendorApi.inStoreSale(itemId, op.key) : vendorApi.undoInStoreSale(itemId, op.saleKey),
    ),
  });
  // Another person signed in (or out): nothing of the last one's taps carries over.
  if (saleGeneration !== session) { soldInStore.reset(); saleGeneration = session; }
  soldInStore.setSender({
    newKey: () => newCommandKey(),
    send: (itemId, op) => sale.mutateAsync({ itemId, op }),
    answered: (itemId, answer, scope) => answerIntoMenu(qc, scope as MenuScope, (menu) => menuWithItemFields(menu, itemId, saleFields(answer))),
    reread: () => rereadMenuSoon(qc),
    classify: phoneSaleFailure,
  });
  return {
    tap: (itemId) => {
      // A menu read already on its way left before this tap: landing, it would show the count from before it.
      void qc.cancelQueries({ queryKey: MENU_READ_KEY, exact: true });
      soldInStore.tap(itemId, menuScope());
    },
    undo: (itemId) => soldInStore.undo(itemId, menuScope()),
    retry: (itemId) => soldInStore.retry(itemId),
  };
}
let saleGeneration: number | null = null;

// ─── Modifiers (option groups + options) ─────────────────────────────────────
// Each mutation resolves to the saved group (with options) or option, so the editor updates its own list from the
// answer, and the menu takes the same answer (no whole-menu download per choice).

export function useAddOptionGroup() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: ({ itemId, data, authSession }: {
      itemId: string;
      data: { name: string; isRequired?: boolean; minSelect?: number; maxSelect?: number };
      authSession?: AuthSessionSnapshot;
    }) => unwrap<any>(vendorApi.addOptionGroup(itemId, data, authSession)),
    onMutate: menuScope,
    onSuccess: (answer, { itemId }, scope) => answerIntoMenu(qc, scope, (menu) => menuWithOptionGroup(menu, itemId, answer)),
  });
}

export function useDeleteOptionGroup() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: (input: string | { id: string; authSession?: AuthSessionSnapshot }) => {
      const id = typeof input === 'string' ? input : input.id;
      const authSession = typeof input === 'string' ? undefined : input.authSession;
      return unwrap(vendorApi.deleteOptionGroup(id, authSession));
    },
    onMutate: menuScope,
    onSuccess: (_answer, input, scope) => answerIntoMenu(qc, scope, (menu) => menuWithoutOptionGroup(menu, typeof input === 'string' ? input : input.id)),
  });
}

export function useAddOption() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: ({ groupId, data, authSession }: {
      groupId: string;
      data: { name: string; additionalPrice?: number };
      authSession?: AuthSessionSnapshot;
    }) => unwrap<any>(vendorApi.addOption(groupId, data, authSession)),
    onMutate: menuScope,
    onSuccess: (answer, { groupId }, scope) => answerIntoMenu(qc, scope, (menu) => menuWithOption(menu, groupId, answer)),
  });
}

export function useDeleteOption() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: (input: string | { id: string; authSession?: AuthSessionSnapshot }) => {
      const id = typeof input === 'string' ? input : input.id;
      const authSession = typeof input === 'string' ? undefined : input.authSession;
      return unwrap(vendorApi.deleteOption(id, authSession));
    },
    onMutate: menuScope,
    onSuccess: (_answer, input, scope) => answerIntoMenu(qc, scope, (menu) => menuWithoutOption(menu, typeof input === 'string' ? input : input.id)),
  });
}

/** Upload (or replace) an item's photo — multipart to the StorageProvider. [TAP-AUDIT] Sized on the phone first, as
 *  section and store photos are (lib/uploadImage: 1280 px, a few hundred KB instead of a 2-4 MB camera original, so
 *  seconds instead of most of a minute on a mobile line); the server still checks, scans and redraws it. If the
 *  phone cannot size it (an older app binary, a decoder failure), the original is sent, never dropped. */
export function useUploadItemImage() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: async ({ id, file, authSession, storeId }: {
      id: string;
      file: { uri: string; name: string; type: string };
      authSession?: AuthSessionSnapshot;
      storeId?: string | null;
    }) => {
      const prepared = await prepareUploadImage(file);
      const form = new FormData();
      form.append('file', { uri: prepared.uri, name: prepared.name, type: prepared.type } as unknown as Blob);
      return unwrap<{ imageUrl?: unknown }>(vendorApi.uploadItemImage(id, form, authSession, storeId));
    },
    onMutate: menuScope,
    onSuccess: (answer, { id }, scope) => answerIntoMenu(qc, scope, (menu) => (
      answer && 'imageUrl' in answer ? menuWithItemFields(menu, id, { imageUrl: answer.imageUrl }) : menu
    )),
  });
}

/** [IMAGES-E2E PR4] A menu section's own photo, sized on the phone first (a smaller upload on
 *  a mobile network); the server checks, scans and redraws it without the camera's data. */
export function useUploadCategoryPhoto() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: async ({ id, file }: { id: string; file: { uri: string; name: string; type: string } }) => {
      const prepared = await prepareUploadImage(file);
      const form = new FormData();
      form.append('file', { uri: prepared.uri, name: prepared.name, type: prepared.type } as unknown as Blob);
      return unwrap(vendorApi.uploadCategoryPhoto(id, form));
    },
    onMutate: menuScope,
    onSuccess: (answer, _vars, scope) => answerIntoMenu(qc, scope, (menu) => menuWithSection(menu, answer)),
  });
}

/** [IMAGES-E2E PR4] Takes a menu section's photo down. */
export function useRemoveCategoryPhoto() {
  const qc = useQueryClient();
  return usePreviewSafeMutation({
    mutationKey: MENU_WRITE_KEY,
    mutationFn: (id: string) => unwrap(vendorApi.removeCategoryPhoto(id)),
    onMutate: menuScope,
    onSuccess: (answer, _id, scope) => answerIntoMenu(qc, scope, (menu) => menuWithSection(menu, answer)),
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
    refetchInterval: () => POLL.vendorAnalytics(),
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
