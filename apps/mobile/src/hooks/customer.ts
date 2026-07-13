import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { track } from '../lib/analytics';
import { customerApi, type AddressInput } from '../services/api';

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

export function useOrder<T = any>(id: string, refetchInterval?: number) {
  return useQuery<T>({
    queryKey: customerKeys.order(id),
    queryFn: () => unwrap<T>(customerApi.getOrder(id)),
    enabled: !!id,
    refetchInterval,
  });
}

export function useRateOrder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { vendorScore?: number; vendorComment?: string; riderScore?: number; riderComment?: string }) =>
      unwrap(customerApi.rateOrder(id, body)),
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
