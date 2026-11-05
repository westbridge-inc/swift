import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { NOT_LIVE } from '@/lib/first-steps';

// ---------------------------------------------------------------------------
// [WEB-ONBOARDING · owner 1 Nov 2026] A store that has just signed up on the website lands on its Orders home. It
// used to read "The board is live." with "Use the switch below to start taking orders" over a switch it cannot use.
// Like the app's waiting store screen (VendorOnboarding), a store not live yet (PENDING_APPROVAL) now reads what is
// left, whose turn it is (the server's `goLive`), and where each step is done on this website. A live store keeps
// the first-order guide. Synthetic values only.
// ---------------------------------------------------------------------------

type Role = 'OWNER' | 'MANAGER' | 'STAFF';
interface Opts { role?: Role; status?: string; goLive?: unknown; items?: unknown[]; vendorType?: string }

function storeApi({ role = 'OWNER', status = 'PENDING_APPROVAL', goLive = { waitingFor: 'OWNER', steps: ['DOCUMENTS', 'PUBLISHED_PHONE'] }, items = [], vendorType = 'RESTAURANT' }: Opts = {}) {
  return mockApi(({ method, url }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') return { body: { success: true, data: {} } };
    if (path === '/vendor/stores') {
      return { body: { success: true, data: { stores: [{ id: 'store-1', name: 'Sample Kitchen', vendorType, isCurrentlyOpen: false, acceptingOrders: false, city: null, isVerified: false }], selectedId: 'store-1', myRole: role } } };
    }
    if (path === '/vendor/profile') {
      return { body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: role, vendors: [{
        id: 'store-1', name: 'Sample Kitchen', vendorType, status, isVerified: false, isCurrentlyOpen: false, acceptingOrders: false,
        selfDeliveryEnabled: false, operatingHours: [], _count: { orders: 0, items: items.length }, goLive,
      }] } } };
    }
    if (path === '/vendor/items') return { body: { success: true, data: items } };
    if (path === '/vendor/orders') return { body: { success: true, data: [], meta: { total: 0 } } };
    if (path === '/vendor/qr') return { body: { success: true, data: { shortUrl: 'https://swift.test/s/SAMPLE', status: 'ACTIVE' } } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('[WEB-ONBOARDING] a store not live yet is told what is left, not that the board is live', () => {
  it('the owner’s turn: the server’s steps, each linking to where it is done; no "board is live", no switch to use', async () => {
    storeApi();
    renderWithQuery(<OrdersPage />);
    const guide = await screen.findByRole('region', { name: 'Your store is not live yet' });
    expect(within(guide).getByText(NOT_LIVE.ownerTurn)).toBeTruthy();
    expect(within(guide).getByText(NOT_LIVE.ownerBody)).toBeTruthy();
    expect(within(guide).getByRole('link', { name: /Add the documents it still needs/ }).getAttribute('href')).toBe('/dashboard/documents');
    expect(within(guide).getByRole('link', { name: /Add the number customers can call/ }).getAttribute('href')).toBe('/dashboard/settings');
    expect(within(guide).getByText(NOT_LIVE.wait)).toBeTruthy();
    // [FULL-LAUNCH 5 Nov 2026] Items need an approved store (the API answers 403 before that): no door to the menu yet.
    expect(await within(guide).findByText('Add your menu once you’re approved')).toBeTruthy();
    expect(within(guide).getByText('You can add items then')).toBeTruthy();
    expect(within(guide).queryByRole('link', { name: /menu|item/i })).toBeNull();
    expect(screen.queryByText('Add your first item')).toBeNull();
    expect(screen.queryByText('The board is live.')).toBeNull();
    expect(screen.queryByText('Use the switch below to start taking orders')).toBeNull();
    expect(screen.queryByText('Share your store link')).toBeNull();
  });

  it('a store with no menu is told its own word', async () => {
    storeApi({ vendorType: 'SUPERMARKET' });
    renderWithQuery(<OrdersPage />);
    const guide = await screen.findByRole('region', { name: 'Your store is not live yet' });
    expect(await within(guide).findByText('Add your products once you’re approved')).toBeTruthy();
    expect(within(guide).queryByText(/your menu/i)).toBeNull();
  });

  it('Swift’s turn: everything is in, a person checks the store; no steps', async () => {
    storeApi({ goLive: { waitingFor: 'SWIFT', steps: [] } });
    renderWithQuery(<OrdersPage />);
    const guide = await screen.findByRole('region', { name: 'Your store is not live yet' });
    expect(within(guide).getByText(NOT_LIVE.swiftTurn)).toBeTruthy();
    expect(within(guide).getByText(NOT_LIVE.swiftBody)).toBeTruthy();
    expect(within(guide).queryByRole('link', { name: /Add the documents/ })).toBeNull();
  });

  it('a manager or staff login is told the owner finishes it (the steps are the owner’s)', async () => {
    storeApi({ role: 'MANAGER' });
    renderWithQuery(<OrdersPage />);
    const guide = await screen.findByRole('region', { name: 'Your store is not live yet' });
    expect(within(guide).getByText(NOT_LIVE.staffBody)).toBeTruthy();
    expect(within(guide).queryByRole('link', { name: /Add the documents/ })).toBeNull();
  });

  it('[REVIEW S4] a store that is not live for another reason (suspended, closed) is never told "The board is live."', async () => {
    for (const status of ['SUSPENDED', 'CLOSED']) {
      storeApi({ status, goLive: null });
      const view = renderWithQuery(<OrdersPage />);
      // [REVIEW-LIGHT2 #2306 S3] the card names the real hold (store-hold-card.test.tsx), never "Not open yet"
      expect(await screen.findByText(status === 'CLOSED' ? 'This store is closed' : 'This store is suspended')).toBeTruthy();
      expect(screen.queryByText('Not open yet'), status).toBeNull();
      expect(screen.queryByText('The board is live.'), status).toBeNull();
      expect(screen.queryByText('Use the switch below to start taking orders'), status).toBeNull();
      view.unmount();
    }
  });

  it('a live store keeps the first-order guide', async () => {
    storeApi({ status: 'ACTIVE', goLive: null });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('The board is live.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Your store is not live yet' })).toBeNull();
  });
});
