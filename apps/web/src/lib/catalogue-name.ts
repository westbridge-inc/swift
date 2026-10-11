'use client';

import { useQuery } from '@tanstack/react-query';
import { useStoreId } from './store-scope';
import { getStores } from './vendor-api';

/**
 * Owner ruling (11 Oct 2026): the website names a store's items tab exactly
 * like the app — by the store's type. The app's map (CATALOGUE_META in
 * apps/mobile/src/modules/vendor/shared.tsx) sits in a file that imports React
 * Native, so the web keeps this copy and a census test (catalogue-name.test.ts)
 * holds the two identical, fallback included.
 */
export const CATALOGUE_LABEL = {
  RESTAURANT: 'Menu',
  SUPERMARKET: 'Inventory',
  STORE: 'Products',
  SERVICE: 'Services',
} as const;

export type CatalogueName = (typeof CATALOGUE_LABEL)[keyof typeof CATALOGUE_LABEL];

export function catalogueName(vendorType: string | null | undefined): CatalogueName {
  return CATALOGUE_LABEL[(vendorType ?? 'RESTAURANT') as keyof typeof CATALOGUE_LABEL] ?? CATALOGUE_LABEL.RESTAURANT;
}

/** The selected store's items-tab name, from the same stores read the console shell makes. */
export function useCatalogueName(): CatalogueName {
  const storeId = useStoreId();
  const stores = useQuery({ queryKey: ['stores'], queryFn: getStores });
  const list = stores.data?.stores ?? [];
  const store = list.find((s) => s.id === storeId) ?? list.find((s) => s.id === stores.data?.selectedId);
  return catalogueName(store?.vendorType);
}
