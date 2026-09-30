import { create } from 'zustand';
import { queryClient } from '../lib/queryClient';
import { disconnectSocket } from '../services/socket';

interface StoreSwitcherState {
  /** The vendor's currently-selected store. Sent as the x-vendor-id header on
   *  vendor requests; null → the API defaults to the owner's first store. */
  selectedStoreId: string | null;
  /** Invalidates callbacks even after an A → B → A round trip. */
  storeGeneration: number;
  feeContextPending: boolean;
  feeContextError: { retry: () => Promise<void>; cancel: () => void } | null;
  setFeeContextPending: (pending: boolean) => void;
  setSelectedStore: (id: string | null) => void;
}

export const useStoreSwitcher = create<StoreSwitcherState>((set, get) => ({
  selectedStoreId: null,
  storeGeneration: 0,
  feeContextPending: false,
  feeContextError: null,
  setFeeContextPending: (pending) => set({ feeContextPending: pending }),
  setSelectedStore: (id) => {
    if (id === get().selectedStoreId) return;
    disconnectSocket();
    // Retire old requests and cached facts BEFORE publishing the new store.
    // Removing also cancels pending queries: their late results cannot seed B.
    // The keyed vendor navigator mounts fresh observers for the new store.
    queryClient.removeQueries({ queryKey: ['vendor'] });
    queryClient.removeQueries({ queryKey: ['verification'] });
    set({ selectedStoreId: id, storeGeneration: get().storeGeneration + 1 });
  },
}));
