import { create } from 'zustand';
import { queryClient } from '../lib/queryClient';
import { disconnectSocket } from '../services/socket';

interface StoreSwitcherState {
  /** The vendor's currently-selected store. Sent as the x-vendor-id header on
   *  vendor requests; null → the API defaults to the owner's first store. */
  selectedStoreId: string | null;
  /** Invalidates callbacks even after an A → B → A round trip. */
  storeGeneration: number;
  /** Only the automatic null → first-store handoff may preserve a queued tap. */
  initialSelectionGeneration: number | null;
  feeContextPending: boolean;
  feeContextError: { retry: () => Promise<void>; cancel: () => void } | null;
  setFeeContextPending: (pending: boolean) => void;
  setSelectedStore: (id: string | null) => void;
  initializeSelectedStore: (id: string) => void;
}

export const useStoreSwitcher = create<StoreSwitcherState>((set, get) => {
  const select = (id: string | null, initial = false) => {
    if (id === get().selectedStoreId) return;
    disconnectSocket();
    // Retire old requests and cached facts BEFORE publishing the new store.
    // Removing also cancels pending queries: their late results cannot seed B.
    // The keyed vendor navigator mounts fresh observers for the new store.
    queryClient.removeQueries({ queryKey: ['vendor'] });
    queryClient.removeQueries({ queryKey: ['verification'] });
    const generation = get().storeGeneration + 1;
    set({ selectedStoreId: id, storeGeneration: generation, initialSelectionGeneration: initial ? generation : null });
  };
  return {
    selectedStoreId: null,
    storeGeneration: 0,
    initialSelectionGeneration: null,
    feeContextPending: false,
    feeContextError: null,
    setFeeContextPending: (pending) => set({ feeContextPending: pending }),
    setSelectedStore: (id) => select(id),
    initializeSelectedStore: (id) => { if (get().selectedStoreId === null) select(id, true); },
  };
});
