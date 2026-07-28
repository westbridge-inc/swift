import { create } from 'zustand';

/**
 * Earner preview (earner excellence R3): a prospective driver/rider can tap
 * through the REAL earner dashboards — Home, Earnings, Active-trip — WITHOUT a
 * real account, documents, or being online, fed realistic sample data. Unlike
 * the vendor preview (a signed-in pending vendor looking at their empty board),
 * the mover previewer is UNAUTHENTICATED, so the mover hooks short-circuit to
 * canned data and every mutation is a no-op. Invariant: preview is fully
 * READ-ONLY and visibly labelled — it never moves money, goes truly online,
 * accepts a real job, or writes server state. `kind` picks which earner face to
 * show (a taxi Driver by default — the app's signature dark map-first home).
 */
export type MoverPreviewKind = 'DRIVER' | 'RIDER';

interface MoverPreviewState {
  preview: boolean;
  kind: MoverPreviewKind;
  enterPreview: (kind?: MoverPreviewKind) => void;
  exitPreview: () => void;
}

export const useMoverPreview = create<MoverPreviewState>((set) => ({
  preview: false,
  kind: 'DRIVER',
  enterPreview: (kind = 'DRIVER') => set({ preview: true, kind }),
  exitPreview: () => set({ preview: false }),
}));
