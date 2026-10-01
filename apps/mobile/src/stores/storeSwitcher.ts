import { create } from 'zustand';
import { queryClient } from '../lib/queryClient';
import { disconnectSocket, reconnectSocketForStoreHandoff } from '../services/socket';

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
    const previous = get().selectedStoreId;
    if (id === previous) {
      // Only an account boundary clears the selection. The departing account's
      // fee notice must not hold the next account's Pay, even with no store.
      if (id === null) set({ feeContextPending: false, feeContextError: null });
      return;
    }
    // Retire old requests and cached facts BEFORE publishing the new store.
    // Removing also cancels pending queries: their late results cannot seed B.
    // The keyed vendor navigator mounts fresh observers for the new store.
    queryClient.removeQueries({ queryKey: ['vendor'] });
    queryClient.removeQueries({ queryKey: ['verification'] });
    const generation = get().storeGeneration + 1;
    set({
      selectedStoreId: id,
      storeGeneration: generation,
      initialSelectionGeneration: initial ? generation : null,
      // An explicit choice supersedes a fee notice still resolving or failed,
      // and retires its controls. Only the shell's automatic first store keeps
      // a cold notice's context while that notice is still being validated.
      ...(initial ? {} : { feeContextPending: false, feeContextError: null }),
    });
    // With nothing selected before, no store room was ever joined.
    if (previous === null) return;
    // Leave the old store's server room only now that B is published, so the
    // retired layer cannot re-join it. Same account: reconnect the shared socket
    // in place, keeping every other mounted layer's listeners (a mover's offers,
    // a customer's live tracking). An account boundary discards it.
    if (id === null) disconnectSocket();
    else reconnectSocketForStoreHandoff();
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
