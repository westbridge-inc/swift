import { create } from 'zustand';

interface VendorPreviewState {
  /** Gated-trials spec §B: a pending vendor may LOOK at their dashboard-to-be
   *  while verification runs — commerce stays locked server-side either way.
   *  This only remembers that they chose to look. */
  preview: boolean;
  enterPreview: () => void;
  exitPreview: () => void;
}

export const useVendorPreview = create<VendorPreviewState>((set) => ({
  preview: false,
  enterPreview: () => set({ preview: true }),
  exitPreview: () => set({ preview: false }),
}));
