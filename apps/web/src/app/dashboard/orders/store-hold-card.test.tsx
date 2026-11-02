import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { STORE_HOLD_WORDS } from '@/lib/store-hold-words';

// ---------------------------------------------------------------------------
// [REVIEW-LIGHT2 #2306 S3] The store status card told EVERY store not live "Not open yet — Your store opens for orders
// once verification is approved." A store held for its weekly fee needs to pay it, a store Swift suspended needs
// support, a closed store will not open. The card now names the store's real hold in the app's own words
// (VendorBillingSuspended, VendorStoreBlocked; the hold read by the app's storeHoldOf) and offers the right door:
// Weekly fee for a fee hold, never "Upload your documents". A store waiting for approval keeps its words.
// ---------------------------------------------------------------------------

function storeApi(status: string, suspensionSource: string | null, role = 'OWNER') {
  return mockApi(({ method, url }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') return { body: { success: true, data: {} } };
    if (path === '/vendor/stores') return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: null, isVerified: true }], selectedId: 'store-1', myRole: role } } };
    if (path === '/vendor/profile') return { body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: role, vendors: [{ id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', status, suspensionSource, isVerified: true, isCurrentlyOpen: false, acceptingOrders: false, selfDeliveryEnabled: false, operatingHours: [], _count: { orders: 3, items: 2 } }] } } };
    if (path === '/vendor/orders') return { body: { success: true, data: [], meta: { total: 0 } } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[#2306 S3] the status card names the store’s real hold', () => {
  it('a fee hold: new orders paused, the weekly fee is what to fix, with its door (owner)', async () => {
    storeApi('SUSPENDED', 'BILLING');
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText(STORE_HOLD_WORDS.FEE_UNPAID.title)).toBeTruthy();
    expect(screen.getByText(STORE_HOLD_WORDS.FEE_UNPAID.owner)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Weekly fee' }).getAttribute('href')).toBe('/dashboard/weekly-fee');
    expect(screen.queryByText('Your store opens for orders once verification is approved.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Upload your documents' })).toBeNull();
  });

  it('a fee hold seen by a manager: ask the owner', async () => {
    storeApi('SUSPENDED', 'BILLING', 'MANAGER');
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText(STORE_HOLD_WORDS.FEE_UNPAID.staff)).toBeTruthy();
  });

  it.each([
    ['SUSPENDED', 'ADMIN', 'SUSPENDED_BY_SWIFT'],
    ['SUSPENDED', null, 'SUSPENDED'],
    ['SUSPENDED', 'WIND_DOWN', 'OWNER_ACCOUNT_CLOSED'],
    ['CLOSED', null, 'CLOSED'],
  ] as const)('%s / %s: the app’s %s words, never "once verification is approved"', async (status, source, hold) => {
    storeApi(status, source);
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText(STORE_HOLD_WORDS[hold].title)).toBeTruthy();
    expect(screen.getByText(STORE_HOLD_WORDS[hold].body)).toBeTruthy();
    expect(screen.queryByText('Your store opens for orders once verification is approved.')).toBeNull();
  });

  it('a store waiting for approval keeps its words', async () => {
    storeApi('PENDING_APPROVAL', null);
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('Not open yet')).toBeTruthy();
    expect(screen.getByText('Your store opens for orders once verification is approved.')).toBeTruthy();
  });

  it('the words are the app’s', () => {
    const mobile = (p: string) => readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'mobile', 'src', p), 'utf8');
    const blocked = mobile('modules/vendor/screens/VendorStoreBlocked.tsx');
    for (const hold of ['SUSPENDED_BY_SWIFT', 'SUSPENDED', 'OWNER_ACCOUNT_CLOSED', 'CLOSED'] as const) {
      expect(blocked, hold).toContain(`title: '${STORE_HOLD_WORDS[hold].title}'`);
      expect(blocked, hold).toContain(`body: '${STORE_HOLD_WORDS[hold].body}'`);
    }
    const billing = mobile('modules/vendor/screens/VendorBillingSuspended.tsx');
    expect(billing).toContain(STORE_HOLD_WORDS.FEE_UNPAID.title);
    expect(billing).toContain(STORE_HOLD_WORDS.FEE_UNPAID.owner.replace(/\.$/, ''));
    expect(billing).toContain(STORE_HOLD_WORDS.FEE_UNPAID.staff.replace(/\.$/, ''));
  });
});
