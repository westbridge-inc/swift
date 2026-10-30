import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { dashboardTabReads, prefetchDashboardTabs } from './dashboard-tab-reads';
import { storeKey } from './store-scope';

// [SPEED 30 Oct · owner] What the business console reads ahead for the other tabs, by role and
// store type (dashboard-shell dashboardNav + each page's own `enabled`), and how.
const keys = (role: 'OWNER' | 'MANAGER' | 'STAFF' | undefined, vendorType?: string) =>
  dashboardTabReads('store-1', role, vendorType).map((read) => (read.queryKey as unknown[]).slice(2).join('/'));

describe('the reads ahead, by role and store type', () => {
  it('staff (or a role not known yet): their Availability and Account tabs only', () => {
    expect(keys('STAFF', 'RESTAURANT')).toEqual(['items/all', 'categories', 'hours', 'cash-settlements']);
    expect(keys(undefined, 'SERVICE')).toEqual(['items/all', 'categories', 'hours', 'cash-settlements']);
  });

  it('a manager adds Insights, and Schedule only at a Services store; never an owner-only read', () => {
    expect(keys('MANAGER', 'RESTAURANT')).toEqual(['items/all', 'categories', 'hours', 'cash-settlements', 'overview']);
    expect(keys('MANAGER', 'SERVICE')).toEqual(['items/all', 'categories', 'hours', 'cash-settlements', 'overview', 'bookings', 'booking-exceptions', 'listing-names']);
  });

  it('the owner adds VAT and the weekly fee; food handlers only for a restaurant', () => {
    expect(keys('OWNER', 'RESTAURANT')).toEqual(['items/all', 'categories', 'hours', 'cash-settlements', 'vat', 'overview', 'subscription', 'food-handlers']);
    expect(keys('OWNER', 'STORE')).toEqual(['items/all', 'categories', 'hours', 'cash-settlements', 'vat', 'overview', 'subscription']);
  });

  it('every read is the store\'s own (its id in the key)', () => {
    for (const read of dashboardTabReads('store-9', 'OWNER', 'SERVICE')) expect((read.queryKey as unknown[]).slice(0, 2)).toEqual(storeKey('store-9'));
  });
});

describe('reading ahead', () => {
  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });

  it('never repeats a read the console already holds, even an old one (the tab refreshes it by its own rule)', async () => {
    const qc = client();
    qc.setQueryData(storeKey('store-1', 'hours'), ['held'], { updatedAt: Date.now() - 60_000 });
    const hours = vi.fn(async () => ['new']);
    const settlements = vi.fn(async () => ({ unsettled: [] }));
    await prefetchDashboardTabs(qc, [{ queryKey: storeKey('store-1', 'hours'), queryFn: hours }, { queryKey: storeKey('store-1', 'cash-settlements'), queryFn: settlements }]);
    expect(hours).not.toHaveBeenCalled();
    expect(qc.getQueryData(storeKey('store-1', 'hours'))).toEqual(['held']);
    expect(settlements).toHaveBeenCalledOnce();
  });

  it('a read that fails is forgotten, so the tab loads it the ordinary way; it is tried once, not retried', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 1 } } });
    const failing = vi.fn(async () => { throw new Error('offline'); });
    await prefetchDashboardTabs(qc, [{ queryKey: storeKey('store-1', 'categories'), queryFn: failing }]);
    expect(failing).toHaveBeenCalledOnce();
    expect(qc.getQueryState(storeKey('store-1', 'categories'))).toBeUndefined();
  });
});
