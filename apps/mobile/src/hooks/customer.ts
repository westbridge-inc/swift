import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type MutateOptions } from '@tanstack/react-query';
import { track } from '../lib/analytics';
import { checkoutAttempt } from '../lib/checkoutAttemptStore';
import { checkoutFailureOutcome, recordCheckoutOutcome, settleUnresolvedIntent, stableBodyHash, type CheckoutObservation, type CheckoutPrincipal, type ReceiptProbe } from '../lib/checkoutAttempt';
import { AuthSessionBoundaryError, getAuthSessionSnapshot, requireAuthSessionForPrincipal, useAuthStore } from '../stores/authStore';
import { homePlaceholderData, homeQueryKey, isHomeFeed, marketDepthVerdict, retainedHomeData } from '../lib/homeReliability';
import { rememberMarketDepth, rememberedMarketDepth, type MarketDepthBody } from '../lib/marketDepthMemory';
import { isAxiosError } from 'axios';
import { marketApi, customerApi, discoveryApi, moderationApi, type AddressInput, type CartQuoteChoices } from '../services/api';
import { samePrincipalBoundary, type AuthSessionSnapshot } from '../lib/authSession';
import type { OrderProjection } from '@swift/types';
import type { PromiseView } from '../lib/promise';

/**
 * Thin React Query wrappers over `customerApi`. Every consumer screen reads data
 * through these so loading / error / refetch / caching behave consistently.
 * The API envelopes payloads as `{ success, data }`; hooks unwrap to inner `data`.
 */
async function unwrap<T = any>(p: Promise<any>): Promise<T> {
  const res = await p;
  return res?.data?.data as T;
}

export const customerKeys = {
  profile: ['customer', 'profile'] as const,
  addresses: ['customer', 'addresses'] as const,
  home: (lat?: number, lng?: number) => ['customer', 'home', lat ?? null, lng ?? null] as const,
  // The PREFIX of every Home feed, whatever coordinates it was fetched for.
  // Anything that changes what Home should show — an order placed, cancelled,
  // a store favourited — invalidates this, not one lat/lng variant.
  homeAll: ['customer', 'home'] as const,
  vendors: (params?: Record<string, string>) => ['customer', 'vendors', params ?? {}] as const,
  search: (q: string, type?: string, lat?: number, lng?: number) => ['customer', 'search', q, type ?? null, lat ?? null, lng ?? null] as const,
  searchSuggestions: (q: string) => ['customer', 'search-suggestions', q] as const,
  searchTrending: ['customer', 'search-trending'] as const,
  vendor: (id: string) => ['customer', 'vendor', id] as const,
  orders: ['customer', 'orders'] as const,
  order: (id: string) => ['customer', 'order', id] as const,
  // [E01] The choices the quote is priced for are part of its identity.
  cart: (lat?: number, lng?: number, choices?: CartQuoteChoices) =>
    ['customer', 'cart', lat ?? null, lng ?? null, choices ?? null] as const,
  notifications: ['customer', 'notifications'] as const,
};

export function useProfile<T = any>() {
  return useQuery<T>({ queryKey: customerKeys.profile, queryFn: () => unwrap<T>(customerApi.getProfile()) });
}

/** Movement R9: "Your rating" — the customer's own aggregate (aggregate only,
 *  never per-rating rows — respect runs both ways). */
export function useMyRating() {
  return useQuery<{ displayRating: number | null; ratingBucket: string; ratingCount: number }>({
    queryKey: ['customer', 'my-rating'],
    queryFn: () => unwrap(customerApi.myRating()),
  });
}

export function useAddresses<T = any>() {
  return useQuery<T>({ queryKey: customerKeys.addresses, queryFn: () => unwrap<T>(customerApi.getAddresses()) });
}

export function useAddAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: AddressInput) => unwrap(customerApi.addAddress(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: customerKeys.addresses }),
  });
}

// Editing, removing and re-defaulting an address all move the destination the
// CART is quoting against, so each one invalidates the cart as well — a stale
// "deliver to" line under a fresh address list is the UI lying about where the
// food is going. (Delete additionally clears the pointer server-side.)
function useAddressMutation<TArg>(fn: (arg: TArg) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.addresses });
      qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
    },
  });
}

export function useUpdateAddress() {
  return useAddressMutation(({ id, data }: { id: string; data: Partial<AddressInput> }) =>
    unwrap(customerApi.updateAddress(id, data)));
}

export function useDeleteAddress() {
  return useAddressMutation((id: string) => unwrap(customerApi.deleteAddress(id)));
}

export function useSetDefaultAddress() {
  return useAddressMutation((id: string) => unwrap(customerApi.setDefaultAddress(id)));
}

/** Home's live-order card row: the shared projection (`vertical`, `fulfillment`
 *  — the words) plus the hold, the promise and the vendor the card draws. */
export type LiveOrderProjection = OrderProjection & {
  holdExpiresAt: string | null;
  placedAt: string;
  scheduledFor?: string | null;
  promise: PromiseView | null;
  vendor: { id: string; name: string; logoUrl?: string | null; vendorType?: string | null } | null;
};

/** The Home feed as the app reads it. Only the live-order card is typed to the
 *  shared contract here; the rails keep their untyped rows (a recorded
 *  follow-up, not this lane's). */
export interface HomeFeed {
  activeOrder: LiveOrderProjection | null;
  popularItems: any[];
  featured: any[];
  nearby: any[];
  orderAgain: any[];
  categories: any[];
  openVendors: any[];
  closedVendors: any[];
}

export function useHome<T = HomeFeed>(lat?: number, lng?: number) {
  const scope = useAuthStore((state) => state.adEventScopeId);
  const [last, setLast] = useState<{ scope: string; data: T } | null>(null);
  const query = useQuery<T>({
    queryKey: homeQueryKey(lat, lng, scope),
    queryFn: async ({ signal }) => {
      const data = await unwrap<T>(customerApi.getHome(lat, lng, signal));
      if (!isHomeFeed(data)) throw new Error('Home response is incomplete');
      return data;
    },
    placeholderData: (previous, previousQuery) => homePlaceholderData(previous, previousQuery, scope),
    // The shared two retries can hold this first-paint body on a spinner for
    // roughly three 10-second request windows. An explicit retry and the next
    // focus/foreground refresh are available after one bounded attempt.
    retry: false,
  });
  useEffect(() => {
    if (query.data !== undefined && !query.isPlaceholderData) setLast({ scope, data: query.data });
  }, [query.data, query.isPlaceholderData, scope]);
  return { ...query, data: retainedHomeData(query.data, last, scope) };
}

export type DiscoveryRail = {
  enabled: boolean;
  categories: Array<{ slug: string; name: string; emoji: string; iconKey: string | null; kind: string; vertical: string; availableVendors: number }>;
};

/** The category rail (#17) — flag-gated server-side; silent on failure (the
 *  rail is garnish, Home never shows an error for it). */
export function useDiscoveryCategories(lat?: number, lng?: number) {
  return useQuery<DiscoveryRail>({
    queryKey: ['discovery', 'categories', lat?.toFixed?.(2), lng?.toFixed?.(2)],
    queryFn: () => unwrap<DiscoveryRail>(discoveryApi.categories({ lat, lng })),
    staleTime: 0, // Availability counts refresh behind the immediately visible cache.
    retry: false,
  });
}

/**
 * [MKT G1/G2] THE MARKET FEED — items across every store.
 *
 * The Market tab used to call `useVendors({ type: 'STORE' })` and render shop
 * cards, so pressing one opened a store and no item ever appeared. The ask was
 * a catalogue: things, by category, spanning stores. This is the hook for it.
 *
 * Infinite by cursor, not by page number — an offset scan over a growing
 * catalogue is the classic browse-feed collapse, and the server refuses a
 * cursor minted under a different sort rather than serving a nonsense page.
 */
export type MarketItem = {
  id: string; name: string; basePrice: number; imageUrl: string | null;
  vendorId: string; vendorName: string; categoryName: string | null;
  /** Recently listed. SERVER-DERIVED — the client never computes "new" from a
   *  timestamp of its own, or two screens would disagree about the same item. */
  isNew: boolean;
};

/**
 * `sort` defaults to `new`, and the screen's section header says "New arrivals"
 * because of it. The endpoint's own default is `popular`, which is the right
 * default for an established catalogue and the wrong one here: at launch depth
 * almost every `totalOrdered` is zero, so "popular" would rank by a tiebreaker
 * while a header called it popular — the UI lying about its own ordering.
 */
/**
 * [MKT G7] Is the Market tab allowed to exist yet?
 *
 * §5.4: "An empty marketplace is worse than no marketplace." The SERVER
 * decides — it is the only side that can see the whole catalogue, and a
 * threshold duplicated here would eventually disagree with the one there.
 *
 * Hidden while unknown, on purpose: a tab that pops in after a network round
 * trip is worse than one that appears on the next launch, and the failure mode
 * we are avoiding is showing an empty market, not hiding a full one.
 */
export function useMarketDepth() {
  return useQuery<MarketDepthBody>({
    queryKey: ['market', 'depth'],
    queryFn: async () => {
      const res = await marketApi.depth();
      const data = res?.data?.data ?? null;
      // An incomplete 200 is a failed read, not data: throwing keeps React
      // Query on the previous verdict instead of replacing it with 'unknown'.
      if (marketDepthVerdict(data) === 'unknown') {
        throw new Error('Market depth response is incomplete');
      }
      rememberMarketDepth(data);
      return data as MarketDepthBody;
    },
    staleTime: 0, // Recheck catalogue eligibility on mount/reconnect, even with a warm cache.
    // [E29] A cold start seeds the query with the last complete verdict, so a
    // failing first read shows what the device last knew. The seed is stale
    // on purpose (0): the server is always asked again, and a later complete
    // 'hidden' verdict replaces the memory and hides the tab.
    initialData: () => rememberedMarketDepth() ?? undefined,
    initialDataUpdatedAt: 0,
  });
}

export function useMarketItems(params: { category?: string; sort?: string } = {}) {
  const sort = params.sort ?? 'new';
  return useInfiniteQuery({
    queryKey: ['market', 'items', params.category ?? 'all', sort],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const res = await marketApi.items({
        ...(params.category ? { category: params.category } : {}),
        sort,
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: 24,
      });
      const body = res?.data?.data ?? {};
      return {
        items: (body.items ?? []) as MarketItem[],
        nextCursor: (body.nextCursor ?? null) as string | null,
        total: typeof body.meta?.total === 'number' ? (body.meta.total as number) : null,
      };
    },
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
  });
}

export function useVendors<T = any>(params?: Record<string, string>) {
  return useQuery<T>({ queryKey: customerKeys.vendors(params), queryFn: () => unwrap<T>(customerApi.getVendors(params)) });
}

/** [B2] The search ENGINE — vendors AND dishes, typo-tolerant, ranked. The
 *  screen's old path was a substring filter that returned nothing for a
 *  plural, a misspelling, or a dish name; this is the finished engine that
 *  sat with zero callers on any surface. */
export function useSearch<T = any>(q: string, opts?: { type?: string; lat?: number; lng?: number }) {
  return useQuery<T>({
    queryKey: customerKeys.search(q, opts?.type, opts?.lat, opts?.lng),
    queryFn: () => unwrap<T>(customerApi.search(q, opts)),
    enabled: q.trim().length >= 2,
    // Type-ahead cadence: keep the previous page while the next keystroke's
    // answer arrives, so the list never flashes empty mid-word.
    placeholderData: keepPreviousData,
  });
}

export function useSearchSuggestions<T = any>(q: string) {
  return useQuery<T>({
    queryKey: customerKeys.searchSuggestions(q),
    queryFn: () => unwrap<T>(customerApi.searchSuggestions(q)),
    enabled: q.trim().length >= 2,
    placeholderData: keepPreviousData,
  });
}

/** Most-ordered dishes across open stores — EARNED ranking (totalOrdered),
 *  never the vendor-set isPopular checkbox. Feeds the no-matches invitation. */
export function useSearchTrending<T = any>(enabled = true) {
  return useQuery<T>({
    queryKey: customerKeys.searchTrending,
    queryFn: () => unwrap<T>(customerApi.searchTrending()),
    enabled,
    staleTime: 0,
  });
}

export function useVendor<T = any>(id: string) {
  return useQuery<T>({
    queryKey: customerKeys.vendor(id),
    queryFn: () => unwrap<T>(customerApi.getVendor(id)),
    enabled: !!id,
  });
}

export function useVendorReviews<T = any>(id: string) {
  return useQuery<T>({
    queryKey: [...customerKeys.vendor(id), 'reviews'],
    queryFn: () => unwrap<T>(customerApi.getVendorReviews(id)),
    enabled: !!id,
  });
}

/** [B15] Flag one public review. Server is idempotent per (rating, reporter),
 *  so a double-tap reads as the same calm success. */
export function useReportRating() {
  return useMutation({
    mutationFn: ({ ratingId, reason, note }: { ratingId: string; reason: 'OFFENSIVE' | 'FALSE_CLAIM' | 'PRIVATE_INFO' | 'SPAM' | 'OTHER'; note?: string }) =>
      unwrap(customerApi.reportRating(ratingId, reason, note)),
    onSuccess: () => track('rating_reported', {}),
  });
}

/** [B15/STORE-001] Flag a store, item, profile or chat message into the
 *  moderation queue. */
export function useReportContent() {
  return useMutation({
    mutationFn: (input: Parameters<typeof moderationApi.report>[0]) => unwrap(moderationApi.report(input)),
    onSuccess: (_d, v) => track('content_reported', { targetType: v.targetType }),
  });
}

/** [STORE-002] One person this user refuses contact with. */
export interface BlockedPerson {
  id: string;
  userId: string;
  name: string;
  blockedAt: string;
  reason: string | null;
}

const blockKeys = { all: ['customer', 'blocks'] as const };

export function useBlockedUsers() {
  return useQuery<BlockedPerson[]>({
    queryKey: blockKeys.all,
    queryFn: () => unwrap<BlockedPerson[]>(moderationApi.listBlocks()),
  });
}

/** Both writes refetch the list. A block is a safety control, and a stale list
 *  would tell someone they are protected from a person they are not — or that
 *  they are still cut off from someone they just let back in. */
function useBlockMutation<TArg>(fn: (arg: TArg) => Promise<unknown>, event: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      track(event, {});
      // Dispatch and chat both consult blocks, so anything showing people —
      // an active order, a conversation — can be wrong until it refetches.
      qc.invalidateQueries({ queryKey: blockKeys.all });
      qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });
}

export function useBlockUser() {
  return useBlockMutation(
    (input: { blockedUserId: string; reason?: string }) => unwrap(moderationApi.block(input)),
    'user_blocked',
  );
}

export function useUnblockUser() {
  return useBlockMutation((userId: string) => unwrap(moderationApi.unblock(userId)), 'user_unblocked');
}

export function useItemSlots<T = any>(itemId: string, date: string) {
  return useQuery<T>({
    queryKey: ['customer', 'slots', itemId, date],
    queryFn: ({ signal }) => unwrap<T>(customerApi.getItemSlots(itemId, date, {
      signal,
      // Appointment selection blocks checkout. One bounded read is preferable
      // to silently extending this loader through three transport attempts;
      // the screen exposes an explicit, user-controlled retry.
      timeout: 8_000,
    })),
    enabled: !!itemId && !!date,
    retry: false,
    // Live exclusivity: a slot someone else just booked disappears for
    // everyone WHILE they're looking at the picker, not only on reopen —
    // the DB unique is still the final judge (409 SLOT_TAKEN on the race).
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

export function useFavorites<T = any>() {
  return useQuery<T>({ queryKey: ['customer', 'favorites'], queryFn: () => unwrap<T>(customerApi.getFavorites()) });
}

export function useToggleFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ vendorId, isFavorite }: { vendorId: string; isFavorite: boolean }) =>
      unwrap(isFavorite ? customerApi.removeFavorite(vendorId) : customerApi.addFavorite(vendorId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer', 'favorites'] });
      qc.invalidateQueries({ queryKey: ['customer', 'home'] });
      qc.invalidateQueries({ queryKey: ['customer', 'vendors'] });
      qc.invalidateQueries({ queryKey: ['customer', 'vendor'] });
    },
  });
}

export function useOrders<T = any>() {
  return useQuery<T>({ queryKey: customerKeys.orders, queryFn: () => unwrap<T>(customerApi.getOrders()) });
}

/** Paginated order history (D6-MOB-02): the endpoint pages at ~20, so the plain
 *  query only ever showed the most recent page — older orders were unreachable.
 *  This walks every page via the FlatList's onEndReached.
 *
 *  HISTORY ONLY. Live orders come from `useLiveOrders` below and are not a
 *  slice of this feed — see the comment there for why that mattered. */
export function useOrdersInfinite() {
  return useInfiniteQuery({
    queryKey: [...customerKeys.orders, 'infinite', 'history'],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const res = await customerApi.getOrders(pageParam as number, { live: false });
      const body = res?.data ?? {};
      return { items: (body.data ?? []) as OrderProjection[], meta: body.meta ?? { page: 1, totalPages: 1 } };
    },
    getNextPageParam: (last: { meta: { page: number; totalPages: number } }) =>
      last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
  });
}

/**
 * EVERY live order, asked for as such.
 *
 * The activity list used to derive its "IN PROGRESS" section by filtering the
 * pages of history it happened to have loaded. History is ordered `placedAt`
 * DESC and pages at 20, so a live order older than the last 20 rows simply was
 * not in the list to be found. Measured on a real account: 19 live orders, only
 * 6 within the first page — thirteen open orders, three of them months old and
 * still awaiting pickup, invisible until the customer scrolled through 80 rows
 * of finished ones. Home showed one of them live the whole time.
 *
 * A filter cannot find what pagination never fetched. So this asks the server
 * the question directly, in one page sized well above any plausible number of
 * simultaneously open orders; `meta.total` is kept so the screen can say so
 * out loud rather than silently truncate.
 */
const LIVE_ORDERS_LIMIT = 50;

export function useLiveOrders() {
  return useQuery({
    queryKey: [...customerKeys.orders, 'live'],
    queryFn: async () => {
      const res = await customerApi.getOrders(1, { live: true, limit: LIVE_ORDERS_LIMIT });
      const body = res?.data ?? {};
      return {
        items: (body.data ?? []) as OrderProjection[],
        total: typeof body.meta?.total === 'number' ? (body.meta.total as number) : null,
      };
    },
  });
}

export function useOrder<T = OrderProjection>(id: string, refetchInterval?: number) {
  return useQuery<T>({
    queryKey: customerKeys.order(id),
    queryFn: () => unwrap<T>(customerApi.getOrder(id)),
    enabled: !!id,
    refetchInterval,
  });
}

export type RatingTagSets = Record<string, { positive: Array<{ slug: string; label: string }>; negative: Array<{ slug: string; label: string }> }>;

/** The R4 tag taxonomy — tiny and stable; cache hard. */
export function useRatingTags() {
  return useQuery<RatingTagSets>({
    queryKey: ['rating-tags'],
    queryFn: () => unwrap<RatingTagSets>(customerApi.ratingTags()),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

/** Per-item thumbs (R5) — fire-and-forget upserts, skippable by design. */
export function useItemFeedback(orderId: string) {
  return useMutation({
    mutationFn: (body: { itemId: string; verdict: 'UP' | 'DOWN' }) => unwrap(customerApi.itemFeedback(orderId, body)),
    meta: { silent: true },
  });
}

export function useRateOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ authSession, ...body }: {
      vendorScore?: number;
      vendorComment?: string;
      riderScore?: number;
      riderComment?: string;
      driverScore?: number;
      driverComment?: string;
      authSession?: AuthSessionSnapshot;
    }) => unwrap(customerApi.rateOrder(id, body, authSession)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.order(id) });
      // The list rows carry the "Rate" affordance — refresh them too.
      qc.invalidateQueries({ queryKey: customerKeys.orders });
    },
  });
}

export function useNotifications<T = any>() {
  return useQuery<T>({
    queryKey: customerKeys.notifications,
    queryFn: () => unwrap<T>(customerApi.getNotifications()),
  });
}

/** [MOB-020] The server already holds an order for this intent (a replayed
 *  receipt under a changed body, or a probe that found one): nothing more is
 *  placed; the screen shows the order that exists. */
export class CheckoutAlreadyPlacedError extends Error {
  constructor(readonly orderIds: string[]) {
    super('This order was already placed.');
    this.name = 'CheckoutAlreadyPlacedError';
  }
}

/** [MOB-020] The same intent is still being placed (a concurrent twin, or a
 *  probe that found the key claimed): hold on, do not place again. */
export class CheckoutInFlightError extends Error {
  constructor() {
    super('This order is already being placed — hold on.');
    this.name = 'CheckoutInFlightError';
  }
}

/** [AX372 R1] What the customer reads while an order's outcome is unknown. */
export const CHECKING_ORDER_MESSAGE = "We're checking whether your order went through.";

/** [AX372 R1] The order's outcome is still unknown after asking the server
 *  (no answer came back, or the server could not say, and the receipt probe
 *  still finds the key in flight): nothing new is placed over it. The intent
 *  stays SENT: the same order tapped again replays its key, a changed one asks
 *  the server first, and the cart screen asks again on its next visit. */
export class CheckoutOutcomeUnknownError extends Error {
  constructor() {
    super(CHECKING_ORDER_MESSAGE);
    this.name = 'CheckoutOutcomeUnknownError';
  }
}

/** The signed-in principal a checkout intent belongs to. */
function checkoutPrincipal(): CheckoutPrincipal {
  const session = getAuthSessionSnapshot();
  if (!session) throw new AuthSessionBoundaryError();
  return { userId: session.userId, generation: session.generation };
}
const checkoutCurrent = (principal: CheckoutPrincipal) => samePrincipalBoundary(getAuthSessionSnapshot(), principal);
function requireCheckoutIntent(key: string, principal: CheckoutPrincipal): AuthSessionSnapshot {
  const session = requireAuthSessionForPrincipal(principal);
  if (checkoutAttempt.currentFor(principal)?.key !== key) throw new AuthSessionBoundaryError();
  return session;
}

/** Every request uses this operation's principal, including across backoff and
 * token rotation. A late answer cannot cross a logout/login boundary. */
async function probeReceipt(key: string, principal: CheckoutPrincipal): Promise<ReceiptProbe> {
  const session = requireCheckoutIntent(key, principal);
  try {
    const res = await customerApi.checkoutReceipt(key, session);
    requireCheckoutIntent(key, principal);
    const data = res.data?.data as ReceiptProbe | undefined;
    if (data?.status === 'placed' && Array.isArray(data.orderIds)) return { status: 'placed', orderIds: data.orderIds };
    if (data?.status === 'none') return { status: 'none' };
    return { status: 'in_flight' };
  } catch {
    requireCheckoutIntent(key, principal);
    return { status: 'in_flight' };
  }
}
async function settleSentIntent(key: string, principal: CheckoutPrincipal, stopped: () => boolean = () => false): Promise<{ receipt: ReceiptProbe; observation: CheckoutObservation }> {
  requireCheckoutIntent(key, principal);
  const observation = checkoutAttempt.observe(key, principal);
  if (!observation) throw new AuthSessionBoundaryError();
  const receipt = await settleUnresolvedIntent(() => probeReceipt(key, principal), {
    stopped: () => stopped() || !checkoutCurrent(principal) || checkoutAttempt.observe(key, principal)?.revision !== observation.revision,
  });
  return { receipt, observation };
}

interface CheckoutOperation { principal: CheckoutPrincipal; payload: any; key?: string }
/** Resolve the prior intent before a changed body can mint another key. */
async function beginCheckoutIntent(operation: CheckoutOperation, checking: (on: boolean) => void): Promise<string> {
  const { principal, payload } = operation;
  requireAuthSessionForPrincipal(principal);
  const bodyHash = stableBodyHash(payload);
  const begun = checkoutAttempt.begin({ principal, bodyHash });
  operation.key = begun.kind === 'ambiguous' ? begun.pending.key : begun.key;
  if (begun.kind !== 'ambiguous') return begun.key;
  checking(true);
  let settled: Awaited<ReturnType<typeof settleSentIntent>>;
  try { settled = await settleSentIntent(begun.pending.key, principal); }
  finally { checking(false); }
  requireCheckoutIntent(begun.pending.key, principal);
  const probe = settled.receipt;
  recordCheckoutOutcome('ambiguous_recovery', probe.status);
  track('checkout_ambiguous_recovery', { outcome: probe.status });
  if (probe.status === 'placed') {
    checkoutAttempt.end(begun.pending.key, principal);
    throw new CheckoutAlreadyPlacedError(probe.orderIds);
  }
  if (probe.status === 'in_flight') throw new CheckoutOutcomeUnknownError();
  // Only authoritative none permits replacement of the unresolved key.
  const key = checkoutAttempt.replaceAfterNone(settled.observation, bodyHash);
  if (!key) throw new CheckoutOutcomeUnknownError();
  operation.key = key;
  return key;
}

export function usePlaceOrder<T = any>() {
  const qc = useQueryClient();
  // Subscribe so an old mutation's result is hidden immediately on account switch.
  useAuthStore((state) => state.sessionGeneration);
  const inFlight = useRef<CheckoutOperation | null>(null);
  const latest = useRef<CheckoutOperation | null>(null);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const current = (operation: CheckoutOperation) => latest.current === operation && checkoutCurrent(operation.principal);
  const m = useMutation<T, unknown, CheckoutOperation>({
    mutationFn: async (operation) => {
      const { payload, principal } = operation;
      const checking = (on: boolean) => { if (current(operation)) setCheckingOutcome(on); };
      const key = await beginCheckoutIntent(operation, checking);
      const session = requireCheckoutIntent(key, principal);
      const send = checkoutAttempt.startSend(key, principal);
      if (!send) throw new AuthSessionBoundaryError();
      try {
        let res;
        try { res = await customerApi.placeOrder(payload, key, session); }
        finally { checkoutAttempt.finishSend(send); }
        requireCheckoutIntent(key, principal);
        if ((res.data as { replayed?: boolean } | undefined)?.replayed) {
          recordCheckoutOutcome('checkout_dedupe_replay');
          track('checkout_dedupe_replay', {});
        }
        return res?.data?.data as T;
      } catch (err) {
        requireCheckoutIntent(key, principal);
        const status = isAxiosError(err) ? err.response?.status : undefined;
        const code = isAxiosError(err) ? (err.response?.data as { error?: { code?: string } } | undefined)?.error?.code : undefined;
        if (status === 422 && code === 'IDEMPOTENCY_KEY_REUSED') {
          recordCheckoutOutcome('key_body_conflict');
          track('checkout_key_body_conflict', {});
          if (!checkoutAttempt.endIfUnchanged(send)) throw new CheckoutOutcomeUnknownError();
          throw new CheckoutAlreadyPlacedError([]);
        }
        if (status === 409 && code === 'DUPLICATE_REQUEST') {
          recordCheckoutOutcome('in_flight_refused');
          throw new CheckoutInFlightError();
        }
        checking(true);
        let observed: Awaited<ReturnType<typeof settleSentIntent>>;
        try { observed = await settleSentIntent(key, principal); }
        finally { checking(false); }
        requireCheckoutIntent(key, principal);
        const settled = observed.receipt;
        recordCheckoutOutcome('ambiguous_recovery', `unknown:${settled.status}`);
        track('checkout_ambiguous_recovery', { outcome: settled.status, unknown: true });
        if (settled.status === 'placed') {
          checkoutAttempt.end(key, principal);
          throw new CheckoutAlreadyPlacedError(settled.orderIds);
        }
        if (checkoutFailureOutcome({ status, code, receipt: settled }) === 'refused') {
          if (!checkoutAttempt.markOpen(observed.observation)) throw new CheckoutOutcomeUnknownError();
          throw err;
        }
        throw new CheckoutOutcomeUnknownError();
      }
    },
    meta: { silent: true },
    onSuccess: (data: any, operation) => {
      if (!current(operation) || !operation.key || !checkoutAttempt.end(operation.key, operation.principal)) return;
      qc.invalidateQueries({ queryKey: customerKeys.orders });
      qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
      track('order_placed', { orders: data?.orders?.length ?? 1 });
    },
    onError: (err, operation) => {
      if (!current(operation)) return;
      if (err instanceof CheckoutAlreadyPlacedError) {
        qc.invalidateQueries({ queryKey: customerKeys.orders });
        qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
      }
    },
    onSettled: (_data, _error, operation) => {
      if (inFlight.current === operation) inFlight.current = null;
    },
  });
  type Options = MutateOptions<T, unknown, any>;
  const callbacks = (operation: CheckoutOperation, options?: Options): MutateOptions<T, unknown, CheckoutOperation> => ({
    onSuccess: (data, _variables, ...context) => { if (current(operation)) options?.onSuccess?.(data, operation.payload, ...context); },
    onError: (error, _variables, ...context) => { if (current(operation)) options?.onError?.(error, operation.payload, ...context); },
    onSettled: (data, error, _variables, ...context) => { if (current(operation)) options?.onSettled?.(data, error, operation.payload, ...context); },
  });
  const start = (payload: any): CheckoutOperation | null => {
    const principal = checkoutPrincipal();
    if (inFlight.current && samePrincipalBoundary(inFlight.current.principal, principal)) return null;
    const operation = { payload, principal };
    inFlight.current = operation; latest.current = operation;
    setCheckingOutcome(false);
    return operation;
  };
  const mutate = (payload: any, options?: Options) => {
    const operation = start(payload);
    if (operation) m.mutate(operation, callbacks(operation, options));
  };
  const mutateAsync = async (payload: any, options?: Options): Promise<T> => {
    const operation = start(payload);
    if (!operation) throw new CheckoutInFlightError();
    try {
      const data = await m.mutateAsync(operation, callbacks(operation, options));
      requireAuthSessionForPrincipal(operation.principal);
      return data;
    } catch (error) {
      requireAuthSessionForPrincipal(operation.principal);
      throw error;
    }
  };
  const visible = latest.current && current(latest.current);
  return { ...m, mutate, mutateAsync, checkingOutcome: !!visible && checkingOutcome,
    data: visible ? m.data : undefined, error: visible ? m.error : null,
    variables: visible ? m.variables?.payload : undefined, failureReason: visible ? m.failureReason : null,
    isIdle: !visible || m.isIdle, status: visible ? m.status : 'idle' as const,
    isSuccess: !!visible && m.isSuccess, isError: !!visible && m.isError, isPending: !!visible && m.isPending };
}

/** Resume only this account's sent intent, adopting a new login generation
 * without allowing any callback from the previous login to complete it. */
export function useCheckoutRecovery(): { recovering: boolean; placedOrderIds: string[] | null } {
  const qc = useQueryClient();
  const generation = useAuthStore((state) => state.sessionGeneration);
  const userId = useAuthStore((state) => state.user?.id);
  const owner = useRef<CheckoutPrincipal | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [placedOrderIds, setPlacedOrderIds] = useState<string[] | null>(null);
  useEffect(() => {
    const session = getAuthSessionSnapshot();
    owner.current = session ? { userId: session.userId, generation: session.generation } : null;
    setPlacedOrderIds(null);
    setRecovering(false);
    if (!session) return;
    const pending = checkoutAttempt.resumeFor({ userId: session.userId, generation: session.generation });
    if (!pending || pending.state !== 'sent') return;
    let cancelled = false;
    const current = () => !cancelled && checkoutCurrent(session);
    setRecovering(true);
    void settleSentIntent(pending.key, session, () => !current()).then(({ receipt: probe, observation }) => {
      if (!current()) return;
      requireCheckoutIntent(pending.key, session);
      recordCheckoutOutcome('ambiguous_recovery', `restart:${probe.status}`);
      track('checkout_ambiguous_recovery', { outcome: probe.status, restart: true });
      if (probe.status === 'placed') {
        checkoutAttempt.end(pending.key, session);
        setPlacedOrderIds(probe.orderIds);
        qc.invalidateQueries({ queryKey: customerKeys.orders });
        qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
      } else if (probe.status === 'none') {
        checkoutAttempt.markOpen(observation);
      }
    }).catch(() => { /* Cancelled ownership leaves the unresolved record intact. */ })
      .finally(() => { if (current()) setRecovering(false); });
    return () => { cancelled = true; };
  }, [qc, generation, userId]);
  const visible = owner.current && checkoutCurrent(owner.current);
  return { recovering: !!visible && recovering, placedOrderIds: visible ? placedOrderIds : null };
}

// --- Cart ---------------------------------------------------------------------

export function useCart<T = any>(lat?: number, lng?: number, choices?: CartQuoteChoices, enabled = true) {
  return useQuery<T>({
    queryKey: customerKeys.cart(lat, lng, choices),
    queryFn: () => unwrap<T>(customerApi.getCart(lat, lng, choices)),
    enabled,
    // [E01] A changed choice (pickup, express, tip) is a new quote. Keep the
    // last one on screen — flagged `isPlaceholderData` — while the server
    // prices the new choice, instead of blanking the cart; the screen holds
    // the order button until the quote for the current choice has arrived.
    placeholderData: keepPreviousData,
  });
}

function invalidateCart(qc: ReturnType<typeof useQueryClient>, principal: CheckoutPrincipal) {
  if (!checkoutCurrent(principal)) return;
  qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
  checkoutAttempt.invalidateCart(principal);
}

interface CartOperation<T> { readonly principal: CheckoutPrincipal | null; readonly generation: number; readonly payload: T }

function cartOwnerCurrent(operation: CartOperation<unknown>): boolean {
  return operation.principal ? checkoutCurrent(operation.principal)
    : getAuthSessionSnapshot() === null && useAuthStore.getState().sessionGeneration === operation.generation;
}
function requireCartOwner(operation: CartOperation<unknown>): void {
  if (!cartOwnerCurrent(operation)) throw new AuthSessionBoundaryError();
}

/** Capture before React Query can await onMutate or queue this operation. Each
 * invocation owns its principal; callbacks and results cannot follow a login. */
function useCartMutation<T>(send: (payload: T, session: AuthSessionSnapshot) => Promise<any>) {
  const qc = useQueryClient();
  useAuthStore((state) => state.sessionGeneration);
  const latest = useRef<CartOperation<T> | null>(null);
  const current = (operation: CartOperation<T>) => latest.current === operation && cartOwnerCurrent(operation);
  const m = useMutation<any, unknown, CartOperation<T>>({
    mutationFn: async (operation) => {
      if (!operation.principal) throw new AuthSessionBoundaryError();
      const session = requireAuthSessionForPrincipal(operation.principal);
      try {
        const data = await send(operation.payload, session);
        requireAuthSessionForPrincipal(operation.principal);
        return data;
      } catch (error) {
        requireAuthSessionForPrincipal(operation.principal);
        throw error;
      }
    },
    meta: { errorOwnerCurrent: (variables: unknown) => cartOwnerCurrent(variables as CartOperation<T>) },
    onSuccess: (_data, operation) => { if (operation.principal) invalidateCart(qc, operation.principal); },
  });
  type Options = MutateOptions<any, unknown, T>;
  const callbacks = (operation: CartOperation<T>, options?: Options): MutateOptions<any, unknown, CartOperation<T>> => ({
    onSuccess: (data, _variables, ...context) => { if (current(operation)) options?.onSuccess?.(data, operation.payload, ...context); },
    onError: (error, _variables, ...context) => { if (current(operation)) options?.onError?.(error, operation.payload, ...context); },
    onSettled: (data, error, _variables, ...context) => { if (current(operation)) options?.onSettled?.(data, error, operation.payload, ...context); },
  });
  const capture = (payload: T): CartOperation<T> => {
    const session = getAuthSessionSnapshot();
    // A guest refusal belongs to this anonymous generation. Queue it through
    // React Query so mutate retains its callback/state contract without throwing.
    const operation = { payload, principal: session ? { userId: session.userId, generation: session.generation } : null,
      generation: session?.generation ?? useAuthStore.getState().sessionGeneration };
    latest.current = operation;
    return operation;
  };
  const mutate = (payload: T, options?: Options) => {
    const operation = capture(payload);
    m.mutate(operation, callbacks(operation, options));
  };
  const mutateAsync = async (payload: T, options?: Options) => {
    const operation = capture(payload);
    try {
      const data = await m.mutateAsync(operation, callbacks(operation, options));
      requireCartOwner(operation);
      return data;
    } catch (error) {
      requireCartOwner(operation);
      throw error;
    }
  };
  const visible = latest.current && current(latest.current);
  return { ...m, mutate, mutateAsync,
    data: visible ? m.data : undefined, error: visible ? m.error : null,
    variables: visible ? m.variables?.payload : undefined, failureReason: visible ? m.failureReason : null,
    isIdle: !visible || m.isIdle, status: visible ? m.status : 'idle' as const,
    isSuccess: !!visible && m.isSuccess, isError: !!visible && m.isError, isPending: !!visible && m.isPending };
}

export function useAddToCart() {
  return useCartMutation((data: {
      vendorId: string;
      itemId: string;
      quantity?: number;
      selectedOptions?: Record<string, unknown>;
      specialInstructions?: string;
    }, session) => unwrap(customerApi.addToCart(data, session)));
}

export function useUpdateCartItem() {
  return useCartMutation(({ id, quantity }: { id: string; quantity: number }, session) =>
    unwrap(customerApi.updateCartItem(id, { quantity }, session)));
}

export function useRemoveCartItem() {
  return useCartMutation((id: string, session) => unwrap(customerApi.removeCartItem(id, session)));
}

export function useClearCart() {
  return useCartMutation((_payload: void, session) => unwrap(customerApi.clearCart(session)));
}

export function useSetCartAddress() {
  return useCartMutation((addressId: string, session) => unwrap(customerApi.setCartAddress(addressId, session)));
}

export function useSetCartTip() {
  return useCartMutation((amount: number, session) => unwrap(customerApi.setCartTip(amount, session)));
}

export function useRemoveCartPromo() {
  return useCartMutation((_payload: void, session) => unwrap(customerApi.removeCartPromo(session)));
}

export function useReorder() {
  return useCartMutation((id: string, session) => unwrap(customerApi.reorder(id, session)));
}

// ── Support / dispute ────────────────────────────────────────────────────
export function useMySupportTickets() {
  return useQuery({ queryKey: ['support', 'tickets'], queryFn: () => unwrap<any[]>(customerApi.supportTickets()) });
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    // Own inline success/reset — opt out of the global error toast so the
    // form can show its own state.
    mutationFn: (data: Parameters<typeof customerApi.createTicket>[0]) => unwrap(customerApi.createTicket(data)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['support', 'tickets'] }),
  });
}

export function useTipOrder(orderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: number | { amount: number; authSession?: AuthSessionSnapshot }) => {
      const amount = typeof input === 'number' ? input : input.amount;
      const authSession = typeof input === 'number' ? undefined : input.authSession;
      return unwrap(customerApi.tipOrder(orderId, amount, authSession));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.order(orderId) });
      qc.invalidateQueries({ queryKey: customerKeys.orders });
    },
  });
}

/** Approve/reject the store's out-of-stock substitution, live (§5.3). */
export function useDecideSubstitution(orderId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, approve }: { lineId: string; approve: boolean }) =>
      customerApi.decideSubstitution(orderId, lineId, approve),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order', orderId] }),
  });
}

/** [ORDER-SPINE S1-6] Tell Swift what happened to a direct-MMG payment. The
 *  order is refetched whatever the outcome — a timeout can mean it landed. */
export function useClaimMmgPayment() {
  const qc = useQueryClient();
  // [R4 · F-PR1262-SOL-01] The order is part of the claim, never the render's
  // closure: a screen React Navigation reuses for another order cannot send
  // order A's confirmation to order B.
  return useMutation({
    mutationFn: ({ orderId, paid, reference }: { orderId: string; paid: boolean; reference?: string }) =>
      customerApi.claimOrderPayment(orderId, { paid, ...(reference ? { reference } : {}) }),
    onSettled: (_data, _error, { orderId }) => qc.invalidateQueries({ queryKey: customerKeys.order(orderId) }),
  });
}
