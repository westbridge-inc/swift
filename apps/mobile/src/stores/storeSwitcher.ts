import { create } from 'zustand';

interface StoreSwitcherState {
  /** The vendor's currently-selected store. Sent as the x-vendor-id header on
   *  vendor requests; null → the API defaults to the owner's first store. */
  selectedStoreId: string | null;
  setSelectedStore: (id: string | null) => void;
}

export const useStoreSwitcher = create<StoreSwitcherState>((set) => ({
  selectedStoreId: null,
  setSelectedStore: (id) => set({ selectedStoreId: id }),
}));
