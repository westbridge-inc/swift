import { create } from 'zustand';

interface StoreSwitcherState {
  /** The vendor's currently-selected store. Sent as the x-vendor-id header on
   *  vendor requests; null → the API defaults to the owner's first store. */
  selectedStoreId: string | null;
  feeContextPending: boolean;
  feeContextError: { retry: () => Promise<void>; cancel: () => void } | null;
  setFeeContextPending: (pending: boolean) => void;
  setSelectedStore: (id: string | null) => void;
}

export const useStoreSwitcher = create<StoreSwitcherState>((set) => ({
  selectedStoreId: null,
  feeContextPending: false,
  feeContextError: null,
  setFeeContextPending: (pending) => set({ feeContextPending: pending }),
  setSelectedStore: (id) => set({ selectedStoreId: id }),
}));
