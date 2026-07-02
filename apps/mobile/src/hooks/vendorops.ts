import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorApi } from '../services/api';
import { useStoreSwitcher } from '../stores/storeSwitcher';

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

/** The stores this account works in; `store` is the selected one and
 *  `myRole` is OWNER / MANAGER / STAFF (drives which tools the UI shows). */
export function useVendorProfile() {
  const q = useQuery({
    queryKey: ['vendor', 'profile'],
    queryFn: () => tryUnwrap(vendorApi.profile()),
    retry: false,
    refetchInterval: 20000,
  });
  const selectedStoreId = useStoreSwitcher((s) => s.selectedStoreId);
  const owner: any = q.data ?? null;
  const stores: any[] = owner?.vendors ?? [];
  const store: any = stores.find((v) => v.id === selectedStoreId) ?? stores[0] ?? null;
  const myRole: 'OWNER' | 'MANAGER' | 'STAFF' = owner?.myRole ?? 'OWNER';
  return { owner, store, stores, myRole, isLoading: q.isLoading };
}

// ─── Staff & roles (owner-only) ──────────────────────────────────────────────

export function useVendorStaff(enabled = true) {
  return useQuery({
    queryKey: ['vendor', 'staff'],
    queryFn: () => unwrap<any[]>(vendorApi.staff()),
    enabled,
  });
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
  return useQuery({
    queryKey: ['vendor', 'orders'],
    queryFn: () => unwrap(vendorApi.orders()),
    enabled,
    refetchInterval: enabled ? 12000 : false,
  });
}

export function useVendorSubscription(enabled = true) {
  // Billing is owner-only (staff & roles §4.1) — staff sessions skip the call.
  return useQuery({ queryKey: ['vendor', 'subscription'], queryFn: () => unwrap(vendorApi.subscription()), enabled });
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
    mutationFn: ({
      id,
      action,
      code,
    }: {
      id: string;
      action: 'accept' | 'preparing' | 'ready' | 'reject' | 'complete-pickup' | 'complete-appointment';
      code?: string;
    }) => {
      if (action === 'accept') return unwrap(vendorApi.acceptOrder(id));
      if (action === 'preparing') return unwrap(vendorApi.preparing(id));
      if (action === 'ready') return unwrap(vendorApi.ready(id));
      if (action === 'complete-pickup') return unwrap(vendorApi.completePickup(id, code));
      if (action === 'complete-appointment') return unwrap(vendorApi.completeAppointment(id));
      return unwrap(vendorApi.reject(id));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vendor', 'orders'] }),
  });
}

// ─── Menu ────────────────────────────────────────────────────────────────────

/** Categories with their nested items (the menu, grouped by section). */
export function useVendorMenu() {
  return useQuery({ queryKey: ['vendor', 'menu'], queryFn: () => unwrap<any[]>(vendorApi.categories()) });
}

export function useCreateCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string }) => unwrap(vendorApi.createCategory(data)),
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

export function useVendorAnalytics() {
  return useQuery({
    queryKey: ['vendor', 'analytics'],
    queryFn: () => unwrap<any>(vendorApi.analytics()),
    refetchInterval: 30000,
  });
}

/** Daily revenue series for the chart (endpoint pre-fills gap days with 0). */
export function useVendorRevenue(days = 14) {
  return useQuery({
    queryKey: ['vendor', 'analytics', 'revenue', days],
    queryFn: () => unwrap<any>(vendorApi.analyticsRevenue(days)),
  });
}

/** Top items by lifetime + last-30-days order counts. */
export function usePopularItems(limit = 8) {
  return useQuery({
    queryKey: ['vendor', 'analytics', 'popular', limit],
    queryFn: () => unwrap<any>(vendorApi.analyticsPopularItems(limit)),
  });
}

export type DayHours = { dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean };

export function useVendorHours() {
  return useQuery({ queryKey: ['vendor', 'hours'], queryFn: () => unwrap<DayHours[]>(vendorApi.hours()) });
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
