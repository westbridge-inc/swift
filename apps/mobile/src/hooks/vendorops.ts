import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorApi } from '../services/api';

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

/** Vendor owner profile; `store` is the first vendor (one store per owner at onboarding). */
export function useVendorProfile() {
  const q = useQuery({
    queryKey: ['vendor', 'profile'],
    queryFn: () => tryUnwrap(vendorApi.profile()),
    retry: false,
    refetchInterval: 20000,
  });
  const owner: any = q.data ?? null;
  const store: any = owner?.vendors?.[0] ?? null;
  return { owner, store, isLoading: q.isLoading };
}

export function useVendorOrders(enabled: boolean) {
  return useQuery({
    queryKey: ['vendor', 'orders'],
    queryFn: () => unwrap(vendorApi.orders()),
    enabled,
    refetchInterval: enabled ? 12000 : false,
  });
}

export function useVendorSubscription() {
  return useQuery({ queryKey: ['vendor', 'subscription'], queryFn: () => unwrap(vendorApi.subscription()) });
}

export function useToggleOpen() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => unwrap(vendorApi.toggleOpen()), onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }) });
}
export function useToggleOrders() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => unwrap(vendorApi.toggleOrders()), onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'profile'] }) });
}

export function useOrderAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'accept' | 'preparing' | 'ready' | 'reject' }) => {
      if (action === 'accept') return unwrap(vendorApi.acceptOrder(id));
      if (action === 'preparing') return unwrap(vendorApi.preparing(id));
      if (action === 'ready') return unwrap(vendorApi.ready(id));
      return unwrap(vendorApi.reject(id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
}
