import { create } from 'zustand';

export type VendorPreviewType = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

const VENDOR_PREVIEW_TYPES: ReadonlySet<string> = new Set([
  'RESTAURANT',
  'SUPERMARKET',
  'STORE',
  'SERVICE',
]);

/** React Native press handlers receive an event argument at runtime. Keep that
 * event (and any stale persisted value) out of the preview discriminator: an
 * object used as `CATALOGUE[type]` previously crashed the whole business app. */
export function isVendorPreviewType(value: unknown): value is VendorPreviewType {
  return typeof value === 'string' && VENDOR_PREVIEW_TYPES.has(value);
}

export function normalizeVendorPreviewType(value: unknown): VendorPreviewType {
  return isVendorPreviewType(value) ? value : 'RESTAURANT';
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
  enterPreview: (type) => set({
    preview: true,
    // A no-argument call is the pending-business preview and intentionally
    // reads that business's real (locked) data. Unknown runtime values are
    // treated the same way; they are never allowed to index sample fixtures.
    previewType: isVendorPreviewType(type) ? type : null,
  }),
  setPreviewType: (type) => set({ previewType: normalizeVendorPreviewType(type) }),
  exitPreview: () => set({ preview: false, previewType: null }),
}));
