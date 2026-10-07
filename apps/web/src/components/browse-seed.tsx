'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { GuestRead } from '@/lib/browse-keys';
import type { VendorDetail } from '@/lib/customer';

/**
 * [W2] Hands a store's menu, drawn by the server into the page (the route's
 * layout), to the page that shows it — the menu's first answer, so the page
 * has it before the browser asks. One store only: the one the layout read.
 */
const StoreSeed = createContext<GuestRead<VendorDetail> | null>(null);

export function StoreSeedProvider({ seed, children }: { seed: GuestRead<VendorDetail> | null; children: ReactNode }) {
  return <StoreSeed.Provider value={seed}>{children}</StoreSeed.Provider>;
}

/** The menu the server drew for this store, if it drew this store's. */
export function useStoreSeed(id: string): GuestRead<VendorDetail> | null {
  const seed = useContext(StoreSeed);
  return seed && seed.data.id === id ? seed : null;
}
