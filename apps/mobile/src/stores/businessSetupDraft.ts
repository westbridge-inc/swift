import { create } from 'zustand';
import { samePrincipalBoundary, type AuthPrincipalBoundary } from '../lib/authSession';
import type { StorePin } from '../lib/storePin';

export type BusinessSetupType = 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';

/** What the List-your-business form holds: plain business contact facts, the
 *  store pin its owner confirmed on the map, and the agreement tick. Never a
 *  document, a credential or an identity fact. */
export interface BusinessSetupDraft {
  name: string;
  type: BusinessSetupType;
  phone: string;
  addr: string;
  city: string;
  agree: boolean;
  /** [Q8] Null until the owner confirms a spot on the map; never the phone's position. */
  pin: StorePin | null;
}

export const EMPTY_BUSINESS_SETUP_DRAFT: Readonly<BusinessSetupDraft> = Object.freeze({
  name: '',
  type: 'RESTAURANT',
  phone: '',
  addr: '',
  city: 'Georgetown',
  agree: false,
  pin: null,
});

type DraftPatch = Partial<BusinessSetupDraft> | ((draft: BusinessSetupDraft) => Partial<BusinessSetupDraft>);

interface BusinessSetupDraftState {
  /** The one signed-in account (user + session generation) the draft belongs to. */
  owner: AuthPrincipalBoundary | null;
  draft: BusinessSetupDraft;
  /** Edit this account's draft. Another account's draft is replaced, never merged. */
  update: (owner: AuthPrincipalBoundary, patch: DraftPatch) => void;
  /** Discard the draft only if it still belongs to `owner`. */
  clearIfOwner: (owner: AuthPrincipalBoundary) => boolean;
  clear: () => void;
}

/**
 * The List-your-business form, kept OUTSIDE the screen so an ordinary remount
 * does not wipe it: VendorRoot swaps the form for its error screen whenever a
 * background profile refetch fails, and "Switch app" to Swift and back remounts
 * the whole vendor stack. In memory only — a business phone, street address and
 * store pin are not written to disk, and the agreement tick never outlives the
 * process that showed the terms. authStore clears it at every login/logout boundary;
 * a durable store creation clears it for exactly the account that submitted.
 */
export const useBusinessSetupDraft = create<BusinessSetupDraftState>((set) => ({
  owner: null,
  draft: EMPTY_BUSINESS_SETUP_DRAFT,
  update: (owner, patch) =>
    set((state) => {
      const current = samePrincipalBoundary(state.owner, owner) ? state.draft : EMPTY_BUSINESS_SETUP_DRAFT;
      const changes = typeof patch === 'function' ? patch(current) : patch;
      return {
        owner: { userId: owner.userId, generation: owner.generation },
        draft: { ...current, ...changes },
      };
    }),
  clearIfOwner: (owner) => {
    let cleared = false;
    set((state) => {
      if (!samePrincipalBoundary(state.owner, owner)) return {};
      cleared = true;
      return { owner: null, draft: EMPTY_BUSINESS_SETUP_DRAFT };
    });
    return cleared;
  },
  clear: () => set({ owner: null, draft: EMPTY_BUSINESS_SETUP_DRAFT }),
}));

/** The draft as `owner` may see it: its own, or a blank form. */
export function businessSetupDraftFor(
  state: Pick<BusinessSetupDraftState, 'owner' | 'draft'>,
  owner: AuthPrincipalBoundary | null,
): BusinessSetupDraft {
  return samePrincipalBoundary(state.owner, owner) ? state.draft : EMPTY_BUSINESS_SETUP_DRAFT;
}

/** A screen edit: written only while the account the screen was rendered for
 *  is still the signed-in one, so a closure that outlived a sign-out or
 *  sign-in writes nothing. */
export function editBusinessSetupDraft(
  signedIn: AuthPrincipalBoundary | null,
  screenOwner: AuthPrincipalBoundary | null,
  patch: DraftPatch,
): boolean {
  if (!screenOwner || !samePrincipalBoundary(signedIn, screenOwner)) return false;
  useBusinessSetupDraft.getState().update(screenOwner, patch);
  return true;
}
