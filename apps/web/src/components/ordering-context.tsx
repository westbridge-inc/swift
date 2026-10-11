'use client';
import { useSyncExternalStore } from 'react';
import { readCheckoutAttempt } from '@/lib/customer';

export type OrderingMode = 'DELIVERY' | 'PICKUP';
export { showsOrderingContext } from '@/lib/ordering-paths';
const STORAGE_KEY = 'swift_ordering_mode';
const listeners = new Set<() => void>();
// Used only where session storage is blocked: the choice then holds for this page.
let unstored: OrderingMode = 'DELIVERY';

function read(): OrderingMode {
  try { return sessionStorage.getItem(STORAGE_KEY) === 'PICKUP' ? 'PICKUP' : 'DELIVERY'; } catch { return unstored; }
}

/** [W5 · review S3] Delivery or pickup is part of the order request, so no
 *  surface (the bar, the store panel, the checkout) changes it while an
 *  earlier order's outcome is unknown. False when refused. */
function setMode(next: OrderingMode): boolean {
  if (readCheckoutAttempt()) return false;
  unstored = next;
  try { sessionStorage.setItem(STORAGE_KEY, next); } catch { /* the choice still holds for this page */ }
  for (const listener of listeners) listener();
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Delivery or pickup for this visit, chosen once and kept for the tab (a
 * reload keeps it; another tab starts on delivery). The server prices and
 * accepts either; nothing here is a price. Kept in the tab's session storage,
 * so only the pages that use it carry this code (the app's frame does not).
 */
export function useOrderingContext(): { mode: OrderingMode; setMode: (_mode: OrderingMode) => boolean } {
  const mode = useSyncExternalStore(subscribe, read, () => 'DELIVERY' as const);
  return { mode, setMode };
}
