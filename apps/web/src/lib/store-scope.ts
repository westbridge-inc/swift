// ---------------------------------------------------------------------------
// [W-04] THE VENDOR DASHBOARD IS MULTI-TENANT ON THE CLIENT.
//
// One operator can own several stores and switch between them from the sidebar.
// Every vendor request is scoped by an `x-vendor-id` header taken from the
// persisted selection, so the SERVER always answers about the right store. The
// client was the part that lied.
//
//  1. EVERY QUERY KEY OMITTED THE STORE. `['orders']`, `['items','all']`,
//     `['overview']`, `['hours']`, `['cash-settlements']`, `['profile']` — one
//     cache entry shared by every store the operator owns.
//
//  2. THE SWITCH ONLY INVALIDATED. `queryClient.invalidateQueries()` marks
//     entries stale and refetches; it does NOT clear them. React Query keeps
//     serving the last successful data while the refetch is in flight, so store
//     A's orders, stock and settlements render under store B's name for the
//     whole round trip — and INDEFINITELY if B's refetch fails, because a
//     failed refetch leaves the previous data in place. The operator is then
//     looking at one store's money under another store's name with no cue.
//
//  3. LOCAL DRAFTS SURVIVED THE SWITCH. The opening-hours editor seeds its rows
//     once (`if (hours.data && !rows)`) and never re-seeds, so after a switch
//     the form still held store A's hours — and Save sent them, with B's header,
//     to store B.
//
// What was already right, and is not re-fixed here: `apiFetch` rejects a
// response whose store context changed while it was in flight
// (`responseContextIsCurrent` in lib/auth.ts), so a late reply cannot be
// applied to the wrong store. That guard is why this item is about CACHE and
// DRAFT reuse rather than about in-flight responses.
//
// The rule: a store id is part of the cache identity, not a header the cache
// forgets about.
// ---------------------------------------------------------------------------

import type { QueryClient } from '@tanstack/react-query';
import { getSelectedStore } from './auth';

/** Namespace that begins every store-owned query key. */
export const STORE_SCOPE = 'store';

/**
 * Stands in for "no store established yet". It is a real, distinct scope: data
 * fetched before a store is known must never be served once one is, which is
 * what a `null` segment would have allowed.
 */
export const UNSCOPED = '__no-store__';

/** The prefix identifying everything one store owns. */
export function storeScope(storeId: string | null | undefined): readonly unknown[] {
  return [STORE_SCOPE, storeId ?? UNSCOPED];
}

/**
 * The key for one store-owned query. The store id is the second segment, so a
 * whole store's cache is addressable — and therefore removable — by prefix.
 */
export function storeKey(
  storeId: string | null | undefined,
  ...parts: readonly (string | number)[]
): readonly unknown[] {
  return [...storeScope(storeId), ...parts];
}

/** The store this render belongs to. The dashboard shell remounts when it changes. */
export function useStoreId(): string | null {
  return getSelectedStore();
}

// --- dirty drafts ----------------------------------------------------------
// Switching stores discards local form state by design (the shell remounts).
// Discarding SILENTLY would lose an operator's typing, so a form that holds
// unsaved edits registers here and the switch asks first. The register calls
// this "require dirty-draft decision"; the decision is the operator's.

const dirtyDrafts = new Set<string>();

/** A form declares whether it currently holds unsaved edits. */
export function setDraftDirty(id: string, dirty: boolean): void {
  if (dirty) dirtyDrafts.add(id);
  else dirtyDrafts.delete(id);
}

export function dirtyDraftIds(): string[] {
  return [...dirtyDrafts].sort();
}

export function hasDirtyDrafts(): boolean {
  return dirtyDrafts.size > 0;
}

/** After a switch the old store's drafts are gone; the register goes with them. */
export function clearDirtyDrafts(): void {
  dirtyDrafts.clear();
}

// --- the switch ------------------------------------------------------------

export interface SwitchStoreInput {
  from: string | null;
  to: string;
  /** Persist the new selection. Called BEFORE the cache work — see below. */
  commit: (_storeId: string) => void;
  /**
   * Asked only when a form holds unsaved edits. Returning false abandons the
   * switch and changes nothing.
   */
  confirmDiscard?: (_draftIds: string[]) => boolean;
}

/**
 * Leave one store for another.
 *
 * Order matters and is the whole point:
 *
 *  1. `commit` first, so the persisted selection is already the NEW store. Any
 *     response still in flight for the old one is then rejected by the
 *     response-context guard in lib/auth.ts rather than landing in the cache.
 *  2. `cancelQueries` on the old scope, so nothing is still trying.
 *  3. `removeQueries` — REMOVE, not invalidate. The old store's bytes leave the
 *     cache entirely, so there is nothing stale to render under the new name
 *     while the new store loads, and nothing left behind if its load fails.
 *
 * Returns false when the operator declined to discard unsaved work.
 */
export async function switchStore(queryClient: QueryClient, input: SwitchStoreInput): Promise<boolean> {
  const { from, to, commit, confirmDiscard } = input;
  if (from === to) return false;

  if (hasDirtyDrafts() && confirmDiscard && !confirmDiscard(dirtyDraftIds())) return false;

  commit(to);
  clearDirtyDrafts();

  await queryClient.cancelQueries({ queryKey: storeScope(from) });
  queryClient.removeQueries({ queryKey: storeScope(from) });
  // Anything fetched before a store was established belongs to no store.
  queryClient.removeQueries({ queryKey: storeScope(null) });
  return true;
}
