import { useMemo, useSyncExternalStore } from 'react';
import type { GuestBasket } from './basket-storage';
const EVENT = 'swift-guest-basket';

/**
 * The browser basket, shared by every mount in this window (#1958 review S4-2 + #1976 review S3-1).
 *
 * - A HYDRATING render always gets the server's answer (empty, not loaded), so it matches the
 *   server HTML even when another part of the page already read the basket (React hydrates
 *   Suspense boundaries one by one; a page's content can hydrate after the shell).
 * - A plain client mount (the checkout's basket, a client navigation) gets the basket as last
 *   read, in its first render: it never draws "empty" for a moment.
 * The basket code (basket-storage) is still its own small chunk, loaded on the first subscribe.
 */
type Snapshot = { basket: GuestBasket; loaded: boolean };
const SERVER_SNAPSHOT: Snapshot = { basket: { version: 1, lines: [] }, loaded: false };
let snapshot: Snapshot = SERVER_SNAPSHOT;
let storage: typeof import('./basket-storage') | null = null;
const listeners = new Set<() => void>();
function publish(storageModule: typeof import('./basket-storage')) {
  storage = storageModule;
  snapshot = { basket: storageModule.readGuestBasket(), loaded: true };
  for (const listener of listeners) listener();
}
function refresh() {
  if (storage) publish(storage);
  else void import('./basket-storage').then(publish);
}
// Every change (this tab's own event, another tab's storage event) re-reads, listened to or not,
// so the basket a later mount reads in its first render is never stale.
if (typeof window !== 'undefined') { window.addEventListener(EVENT, refresh); window.addEventListener('storage', refresh); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  refresh(); // a fresh read for every new mount (storage can change without an event, e.g. cleared)
  return () => { listeners.delete(listener); };
}

export function useGuestBasket() {
  const current = useSyncExternalStore(subscribe, () => snapshot, () => SERVER_SNAPSHOT);
  return useMemo(() => ({ ...current.basket, loaded: current.loaded }), [current]);
}
