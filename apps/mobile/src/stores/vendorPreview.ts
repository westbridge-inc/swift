import { create } from 'zustand';

export type VendorPreviewType = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

interface VendorPreviewState {
  /** Gated-trials spec §B: a pending vendor may LOOK at their dashboard-to-be
   *  while verification runs — commerce stays locked server-side either way. */
  preview: boolean;
  /**
   * Which business type to show with READ-ONLY SAMPLE data (vendor excellence
   * R4). When set, a prospective (UNauthenticated) vendor is tapping through a
   * type-tailored dashboard fed canned data — the hooks short-circuit and every
   * mutation no-ops. When NULL, `preview` keeps its original meaning: a signed-in
   * PENDING vendor peeking at their own (real, empty) store while KYC runs.
   */
  previewType: VendorPreviewType | null;
  enterPreview: (type?: VendorPreviewType) => void;
  setPreviewType: (type: VendorPreviewType) => void;
  exitPreview: () => void;
}

export const useVendorPreview = create<VendorPreviewState>((set) => ({
  preview: false,
  previewType: null,
  // No arg = the original pending-vendor peek (real data). A type = the new
  // unauthenticated sample-data walk-through of that business type.
  enterPreview: (type) => set({ preview: true, previewType: type ?? null }),
  setPreviewType: (type) => set({ previewType: type }),
  exitPreview: () => set({ preview: false, previewType: null }),
}));
