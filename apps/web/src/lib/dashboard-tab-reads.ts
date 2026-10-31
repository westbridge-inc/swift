import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { storeKey } from './store-scope';
import { getCashSettlements, getCategories, getHours, getItems, getOverview, getSubscription } from './vendor-api';
import { getStoreVat } from './store-vat-read';
import { getFoodHandlers } from './food-handlers-api';
import { getBookingExceptions, getBookings, getListingNames } from './booking-api';
import type { VendorMemberRole } from './vendor-hub';

// ---------------------------------------------------------------------------
// [SPEED 30 Oct · owner] The business console's tabs open with their content.
//
// Once the board has loaded and the console is idle, the reads the OTHER tabs
// of this login make on their first draw are made once, so a tap on a tab finds
// them. Each entry is the page's own read: the same key and the same call, and
// only under the same role and store-type rule the page uses to ask for it
// (dashboard-shell dashboardNav + each page's `enabled`). Staff never prefetch
// a read they would not make themselves. This module is its own chunk, loaded
// after the board has drawn: none of it is in a page's first load.
// ---------------------------------------------------------------------------

export type TabRead = { queryKey: QueryKey; queryFn: () => Promise<unknown> };

/** The first-draw reads of the tabs this login sees at this store, other than the board's own. */
export function dashboardTabReads(storeId: string, role: VendorMemberRole | undefined, vendorType: string | undefined): TabRead[] {
  const key = (...parts: string[]) => storeKey(storeId, ...parts);
  const manager = role === 'OWNER' || role === 'MANAGER';
  const owner = role === 'OWNER';
  // Menu / Availability (every role): inventory/page.tsx items + categories, and the owner's VAT classes.
  const reads: TabRead[] = [
    { queryKey: key('items', 'all'), queryFn: () => getItems() },
    { queryKey: key('categories'), queryFn: getCategories },
    // Account (every role): the opening hours and what the store owes riders (any member may read and confirm them).
    { queryKey: key('hours'), queryFn: getHours },
    { queryKey: key('cash-settlements'), queryFn: getCashSettlements },
  ];
  // Staff: nothing more (no Insights, no Schedule, no owner cards).
  if (!manager) return reads;
  if (owner) reads.push({ queryKey: key('vat'), queryFn: getStoreVat });
  // Insights (owners and managers).
  reads.push({ queryKey: key('overview'), queryFn: getOverview });
  // Schedule (a Services store's owners and managers).
  if (vendorType === 'SERVICE') {
    reads.push(
      { queryKey: key('bookings'), queryFn: getBookings },
      { queryKey: key('booking-exceptions'), queryFn: getBookingExceptions },
      { queryKey: key('listing-names'), queryFn: getListingNames },
    );
  }
  // Account: the owner's fee and food-handler cards.
  if (owner) {
    reads.push({ queryKey: key('subscription'), queryFn: getSubscription });
    if (vendorType === undefined || vendorType === 'RESTAURANT') reads.push({ queryKey: key('food-handlers'), queryFn: getFoodHandlers });
  }
  return reads;
}

/**
 * Makes each read the cache does not hold yet, once (no retry). A read the
 * cache already holds is left alone: the page refreshes it by its own rule when
 * it opens, so this never repeats a request. A failed prefetch is forgotten, so
 * the tab later loads it the ordinary way (its own loading words, then its own
 * failure words) instead of opening on an error nobody saw happen.
 */
export function prefetchDashboardTabs(client: QueryClient, reads: readonly TabRead[]): Promise<void> {
  return Promise.all(reads.map(async ({ queryKey, queryFn }) => {
    if (client.getQueryState(queryKey)) return;
    await client.prefetchQuery({ queryKey, queryFn, retry: false });
    const query = client.getQueryCache().find({ queryKey, exact: true });
    if (query && query.state.status === 'error' && query.state.data === undefined && query.getObserversCount() === 0) {
      client.removeQueries({ queryKey, exact: true });
    }
  })).then(() => undefined);
}

/**
 * Starts `prefetchDashboardTabs(reads)` once nothing is on its way (the board's own reads first),
 * once. Returns the stop the console calls when the store, the role or the page goes away.
 */
export function prefetchWhenIdle(client: QueryClient, reads: readonly TabRead[]): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    timer = undefined;
    if (!live || client.isFetching() > 0) return;
    live = false;
    unsubscribe();
    void prefetchDashboardTabs(client, reads);
  };
  const unsubscribe = client.getQueryCache().subscribe(() => { if (live && !timer) timer = setTimeout(check, 0); });
  timer = setTimeout(check, 0);
  return () => { live = false; unsubscribe(); if (timer) clearTimeout(timer); };
}
