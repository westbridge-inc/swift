import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { track } from '../lib/analytics';
import { customerApi, discoveryApi, type AddressInput } from '../services/api';
import type { AuthSessionSnapshot } from '../lib/authSession';

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
  vendors: (params?: Record<string, string>) => ['customer', 'vendors', params ?? {}] as const,
  vendor: (id: string) => ['customer', 'vendor', id] as const,
  orders: ['customer', 'orders'] as const,
  order: (id: string) => ['customer', 'order', id] as const,
  cart: (lat?: number, lng?: number) => ['customer', 'cart', lat ?? null, lng ?? null] as const,
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

export function useHome<T = any>(lat?: number, lng?: number) {
  return useQuery<T>({ queryKey: customerKeys.home(lat, lng), queryFn: () => unwrap<T>(customerApi.getHome(lat, lng)) });
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
    staleTime: 60_000,
    retry: false,
  });
}

export function useVendors<T = any>(params?: Record<string, string>) {
  return useQuery<T>({ queryKey: customerKeys.vendors(params), queryFn: () => unwrap<T>(customerApi.getVendors(params)) });
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

export function useItemSlots<T = any>(itemId: string, date: string) {
  return useQuery<T>({
    queryKey: ['customer', 'slots', itemId, date],
    queryFn: () => unwrap<T>(customerApi.getItemSlots(itemId, date)),
    enabled: !!itemId && !!date,
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
 *  This walks every page via the FlatList's onEndReached. */
export function useOrdersInfinite() {
  return useInfiniteQuery({
    queryKey: [...customerKeys.orders, 'infinite'],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const res = await customerApi.getOrders(pageParam as number);
      const body = res?.data ?? {};
      return { items: (body.data ?? []) as any[], meta: body.meta ?? { page: 1, totalPages: 1 } };
    },
    getNextPageParam: (last: { meta: { page: number; totalPages: number } }) =>
      last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
  });
}

export function useOrder<T = any>(id: string, refetchInterval?: number) {
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

export function usePlaceOrder<T = any>() {
  const qc = useQueryClient();
  return useMutation<T, unknown, any>({
    mutationFn: (payload: any) => unwrap<T>(customerApi.placeOrder(payload)),
    // Checkout shows its own inline error (orderErr) — no global toast on top.
    meta: { silent: true },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: customerKeys.orders });
      qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
      track('order_placed', { orders: data?.orders?.length ?? 1 });
    },
  });
}

// --- Cart ---------------------------------------------------------------------

export function useCart<T = any>(lat?: number, lng?: number) {
  return useQuery<T>({ queryKey: customerKeys.cart(lat, lng), queryFn: () => unwrap<T>(customerApi.getCart(lat, lng)) });
}

function invalidateCart(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['customer', 'cart'] });
}

export function useAddToCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      vendorId: string;
      itemId: string;
      quantity?: number;
      selectedOptions?: Record<string, unknown>;
      specialInstructions?: string;
    }) => unwrap(customerApi.addToCart(data)),
    onSuccess: () => invalidateCart(qc),
  });
}

export function useUpdateCartItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, quantity }: { id: string; quantity: number }) =>
      unwrap(customerApi.updateCartItem(id, { quantity })),
    onSuccess: () => invalidateCart(qc),
  });
}

export function useRemoveCartItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(customerApi.removeCartItem(id)),
    onSuccess: () => invalidateCart(qc),
  });
}

export function useClearCart() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(customerApi.clearCart()),
    onSuccess: () => invalidateCart(qc),
  });
}

export function useSetCartAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (addressId: string) => unwrap(customerApi.setCartAddress(addressId)),
    onSuccess: () => invalidateCart(qc),
  });
}

export function useSetCartTip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amount: number) => unwrap(customerApi.setCartTip(amount)),
    onSuccess: () => invalidateCart(qc),
  });
}

export function useReorder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(customerApi.reorder(id)),
    onSuccess: () => invalidateCart(qc),
  });
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
