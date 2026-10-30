import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { vendorRead } from './vendorops';

// ---------------------------------------------------------------------------
// [SPEED 30 Oct · owner] A store's tabs open with their content.
//
// The Orders board warms most of what the other tabs show (menu, hours, QR,
// overview, revenue, ops, the owner's fee). What it does not warm is read here,
// once, after the board's own reads have landed: a first visit to Insights,
// Account or Schedule then draws at once instead of a spinner (and Insights'
// lower cards no longer wait for the upper ones to load before they ask).
//
// Each read is the tab's own (hooks/vendorops `vendorRead`), asked only for a
// role that sees the tab and the card, exactly as the tab bar and the screens
// decide (VendorStack VendorTabs, VendorAccountScreen): staff prefetch nothing
// (their Availability tab and Account are already warm from the board). Never
// in a sample preview. A read the cache already holds is left alone, and a
// failed prefetch is forgotten, so the tab later loads it the ordinary way.
// ---------------------------------------------------------------------------

export type VendorTabRead = { queryKey: QueryKey; queryFn: () => Promise<unknown>; staleTime?: number };
export type VendorTabRole = 'OWNER' | 'MANAGER' | 'STAFF' | undefined;

/** The first-draw reads of the tabs this role sees that the Orders board does not already make. */
export function vendorTabReads(role: VendorTabRole, isService: boolean): VendorTabRead[] {
  const manager = role === 'OWNER' || role === 'MANAGER';
  if (!manager) return [];
  const reads: VendorTabRead[] = [
    // Insights (owners and managers): the top list, then every lower card.
    vendorRead.popularItems(8),
    vendorRead.cashSettlements(),
    vendorRead.busyHours(),
    vendorRead.repeatCustomers(),
    vendorRead.standing(),
    vendorRead.itemFeedback(),
    vendorRead.reviews(),
    // Account (owners and managers): promotions.
    vendorRead.promos(),
  ];
  // Schedule (a Services store's owners and managers).
  if (isService) reads.push(vendorRead.bookings(), vendorRead.bookingExceptions());
  // Account (owner only): the team.
  if (role === 'OWNER') reads.push(vendorRead.staff());
  return reads;
}

/** Makes each read the cache does not hold yet, once and without retry; a failed one is forgotten. */
export function prefetchVendorTabs(client: QueryClient, reads: readonly VendorTabRead[]): Promise<void> {
  return Promise.all(reads.map(async (read) => {
    if (client.getQueryState(read.queryKey)) return;
    await client.prefetchQuery({ ...read, retry: false });
    const query = client.getQueryCache().find({ queryKey: read.queryKey, exact: true });
    if (query && query.state.status === 'error' && query.state.data === undefined && query.getObserversCount() === 0) {
      client.removeQueries({ queryKey: read.queryKey, exact: true });
    }
  })).then(() => undefined);
}

/**
 * Runs `prefetchVendorTabs(reads)` once nothing is on its way (the screen's own
 * reads first). Again only when `scope` changes (store, role, type; or earner
 * kind). Nothing while `reads` is empty.
 */
export function useIdlePrefetch(reads: readonly VendorTabRead[], scope: string) {
  const client = useQueryClient();
  const latest = useRef(reads);
  latest.current = reads;
  const empty = reads.length === 0;
  useEffect(() => {
    if (empty) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      timer = undefined;
      if (!live || client.isFetching() > 0) return;
      live = false;
      unsubscribe();
      void prefetchVendorTabs(client, latest.current);
    };
    const unsubscribe = client.getQueryCache().subscribe(() => { if (live && !timer) timer = setTimeout(check, 0); });
    timer = setTimeout(check, 0);
    return () => { live = false; unsubscribe(); if (timer) clearTimeout(timer); };
  }, [client, scope, empty]);
}

/** The store's tabs: once per store, role and store type (a store switch remounts the tabs and wipes ['vendor']). Never in a preview. */
export function useVendorTabPrefetch({ storeId, role, isService, preview }: { storeId: string | undefined; role: VendorTabRole; isService: boolean; preview: boolean }) {
  const reads = storeId && !preview ? vendorTabReads(role, isService) : [];
  useIdlePrefetch(reads, `${storeId}:${role}:${isService}`);
}
