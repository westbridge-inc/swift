import { create } from 'zustand';

/** The four business types the sample dashboard can show — the same four as
 *  the List-your-business picker. */
export const VENDOR_PREVIEW_TYPES = ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'] as const;

export type VendorPreviewType = (typeof VENDOR_PREVIEW_TYPES)[number];

export function isVendorPreviewType(value: unknown): value is VendorPreviewType {
  return typeof value === 'string' && (VENDOR_PREVIEW_TYPES as readonly string[]).includes(value);
}

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
  // Anything that is not one of the four types — a press event from a button
  // bound straight to this action, a missing or unknown type — is the peek.
  // A stored type swaps every vendor hook to canned data and lets the root
  // navigator skip sign-in, so only one of the four types ever sets it.
  enterPreview: (type) => set({ preview: true, previewType: isVendorPreviewType(type) ? type : null }),
  setPreviewType: (type) => {
    if (isVendorPreviewType(type)) set({ previewType: type });
  },
  exitPreview: () => set({ preview: false, previewType: null }),
}));
