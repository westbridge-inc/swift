import { create } from 'zustand';

/**
 * Earner preview (earner excellence R3): a prospective driver/rider can tap
 * through the REAL earner dashboards — Home, Earnings, Active-trip — WITHOUT
 * being verified or online, fed realistic sample data. Two doors open it:
 *   - 'welcome': "Preview the driver app" on the first-open screen, for someone
 *     with no account (signed out);
 *   - 'documents': "Preview your dashboard" in the document area, for a signed-in
 *     rider or taxi driver whose documents are still being checked [owner,
 *     1 Oct 2026]. Their session is real, so read-only is enforced twice: every
 *     mutation hook is a no-op here, and the app client refuses any write while
 *     the preview is on screen (lib/previewWriteGuard).
 * Invariant: preview is fully READ-ONLY and visibly labelled — it never moves
 * money, goes truly online, accepts a real job, marks anyone verified, or
 * writes server state. `kind` picks which earner face to show; `origin` is
 * where leaving the preview returns to. The preview is principal-scoped: every
 * sign-in and sign-out ends it (stores/authStore).
 */
export type MoverPreviewKind = 'DRIVER' | 'RIDER';
export type MoverPreviewOrigin = 'welcome' | 'documents';

const KINDS: readonly string[] = ['DRIVER', 'RIDER'];

export function isMoverPreviewKind(value: unknown): value is MoverPreviewKind {
  return typeof value === 'string' && KINDS.includes(value);
}

interface MoverPreviewState {
  preview: boolean;
  kind: MoverPreviewKind;
  origin: MoverPreviewOrigin;
  enterPreview: (kind?: MoverPreviewKind, origin?: MoverPreviewOrigin) => void;
  exitPreview: () => void;
}

export const useMoverPreview = create<MoverPreviewState>((set) => ({
  preview: false,
  kind: 'DRIVER',
  origin: 'welcome',
  // A taxi Driver from the welcome screen by default — the app's signature
  // map-first home. Anything that is not one of the two faces (a press event
  // from a button bound straight to this action) is the default, never a kind.
  enterPreview: (kind, origin) => set({
    preview: true,
    kind: isMoverPreviewKind(kind) ? kind : 'DRIVER',
    origin: origin === 'documents' ? 'documents' : 'welcome',
  }),
  exitPreview: () => set({ preview: false }),
}));
