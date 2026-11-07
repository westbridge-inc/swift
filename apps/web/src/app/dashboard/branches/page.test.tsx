import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => '/dashboard/branches' }));
import BranchesPage from './page';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] The Branches page: every branch's figures and all together, every branch's open
// orders on one board, and pause / take orders / copy hours across ticked branches, one request per branch over that
// branch's own route (the header names THAT branch), then which ones did not go through and why.
// ---------------------------------------------------------------------------

const writes: Array<{ method: string; path: string; store: string | undefined; body: unknown }> = [];
const stores = [
  { id: 'north', name: 'Royal North', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: 'Georgetown', isVerified: true, status: 'ACTIVE', awaitingApproval: false },
  { id: 'camp', name: 'Royal Camp', vendorType: 'RESTAURANT', isCurrentlyOpen: true, acceptingOrders: true, city: 'Georgetown', isVerified: true, status: 'ACTIVE', awaitingApproval: false },
  { id: 'east', name: 'Royal East', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: 'Georgetown', isVerified: false, status: 'PENDING_APPROVAL', awaitingApproval: true, goLive: { waitingFor: 'SWIFT', steps: [] } },
  { id: 'south', name: 'Royal South', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: 'Georgetown', isVerified: false, status: 'PENDING_APPROVAL', awaitingApproval: true, goLive: { waitingFor: 'OWNER', steps: ['DOCUMENTS'] } },
  { id: 'west', name: 'Royal West', vendorType: 'RESTAURANT', isCurrentlyOpen: false, acceptingOrders: false, city: 'Georgetown', isVerified: false, status: 'PENDING_APPROVAL', awaitingApproval: true, goLive: { waitingFor: 'OWNER', steps: ['PUBLISHED_PHONE', 'DOCUMENTS'] } },
];
const fig = (orders: number, revenue: number) => ({ orders, revenue });

function api(opts: { role?: string; refuse?: string } = {}) {
  return mockApi(({ method, url, init }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    const store = (init?.headers as Record<string, string> | undefined)?.['x-vendor-id'];
    if (method !== 'GET') {
      writes.push({ method, path, store, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (store === opts.refuse) return { status: 403, body: { success: false, error: { code: 'STORE_SUSPENDED', message: 'This store is suspended.' } } };
      return { body: { success: true, data: {} } };
    }
    if (path === '/vendor/stores') return { body: { success: true, data: { stores, selectedId: 'north', myRole: opts.role ?? 'OWNER' } } };
    if (path === '/vendor/stores/summary') return { body: { success: true, data: {
      branches: [
        { vendorId: 'north', name: 'Royal North', city: null, today: fig(2, 3000), week: fig(9, 20000), month: fig(30, 90000), pendingOrders: 1, queueValue: 1500 },
        { vendorId: 'camp', name: 'Royal Camp', city: null, today: fig(1, 2500), week: fig(4, 9000), month: fig(10, 30000), pendingOrders: 1, queueValue: 2500 },
      ],
      total: { today: fig(3, 5500), week: fig(13, 29000), month: fig(40, 120000), pendingOrders: 2, queueValue: 4000 },
    } } };
    if (path === '/vendor/orders') {
      expect(url.searchParams.get('scope')).toBe('all');
      return { body: { success: true, data: [
        { id: 'o1', orderNumber: 'SW-1', status: 'PENDING', orderType: 'FOOD_DELIVERY', placedAt: new Date().toISOString(), totalAmount: '1500.00', items: [], vendor: { id: 'north', name: 'Royal North' } },
        { id: 'o2', orderNumber: 'SW-2', status: 'PREPARING', orderType: 'FOOD_DELIVERY', placedAt: new Date().toISOString(), totalAmount: '2500.00', items: [], vendor: { id: 'camp', name: 'Royal Camp' } },
        { id: 'o3', orderNumber: 'SW-3', status: 'DELIVERED', orderType: 'FOOD_DELIVERY', placedAt: new Date().toISOString(), totalAmount: '900.00', items: [], vendor: { id: 'camp', name: 'Royal Camp' } },
      ] } };
    }
    if (path === '/vendor/hours') return { body: { success: true, data: [{ dayOfWeek: 1, openTime: '09:00', closeTime: '21:00', isClosed: false }, { dayOfWeek: 0, isClosed: true }] } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  writes.length = 0;
  nav.push.mockReset();
  (await import('@/lib/auth')).setSelectedStore('north');
});

describe('[CHAINS] the Branches page', () => {
  it('shows each branch\'s figures and all branches together; a waiting branch says so; the owner may add a branch', async () => {
    api();
    renderWithQuery(<BranchesPage />);
    expect(await screen.findByText('All branches')).toBeTruthy();
    expect(screen.getByText('3 · $5,500')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a branch' }).getAttribute('href')).toBe('/dashboard/branches/add');
    expect(await screen.findByText('Royal East · waiting for Swift’s approval')).toBeTruthy();
  });

  it('every branch\'s open orders on one board, each naming its branch (done ones left out)', async () => {
    api();
    renderWithQuery(<BranchesPage />);
    expect(await screen.findByText('#SW-1')).toBeTruthy();
    expect(screen.getByText('#SW-2')).toBeTruthy();
    expect(screen.queryByText('#SW-3')).toBeNull();
    expect(screen.getByRole('button', { name: "Open Royal Camp's orders" })).toBeTruthy();
  });

  it('pause orders at the ticked branches: one request per branch, each with ITS store header; a refusal is named', async () => {
    api({ refuse: 'camp' });
    const { user } = renderWithQuery(<BranchesPage />);
    await user.click(await screen.findByRole('checkbox', { name: /Royal North/ }));
    await user.click(screen.getByRole('checkbox', { name: /Royal Camp/ }));
    await user.click(screen.getByRole('button', { name: 'Pause orders' }));
    await waitFor(() => expect(screen.getByText('Done for 1 of 2 branches. Not done: Royal Camp: This store is suspended.')).toBeTruthy());
    expect(writes).toEqual([
      { method: 'PUT', path: '/vendor/vendor/toggle-orders', store: 'north', body: { acceptingOrders: false } },
      { method: 'PUT', path: '/vendor/vendor/toggle-orders', store: 'camp', body: { acceptingOrders: false } },
    ]);
  });

  it('copies the selected branch\'s hours to the other ticked branches (never back to itself)', async () => {
    api();
    const { user } = renderWithQuery(<BranchesPage />);
    await user.click(await screen.findByRole('checkbox', { name: /Royal North/ }));
    await user.click(screen.getByRole('checkbox', { name: /Royal Camp/ }));
    await user.click(screen.getByRole('button', { name: /Copy Royal North’s hours/ }));
    await waitFor(() => expect(screen.getByText('Done for 1 branch.')).toBeTruthy());
    expect(writes).toEqual([{ method: 'PUT', path: '/vendor/hours', store: 'camp', body: { hours: [
      { dayOfWeek: 0, isClosed: true },
      { dayOfWeek: 1, openTime: '09:00', closeTime: '21:00', isClosed: false },
    ] } }]);
  });

  // [REVIEW-F #2220 S3-1] Whose turn it is, from the server's go-live; the owner's steps with a way to them.
  it('a branch waiting for its OWNER is never "waiting for Swift": its steps are named, and a button opens its Settings', async () => {
    api();
    const { user } = renderWithQuery(<BranchesPage />);
    expect(await screen.findByText('Royal West · not live yet: finish setting it up')).toBeTruthy();
    expect(screen.queryByText('Royal West · waiting for Swift’s approval')).toBeNull();
    expect(screen.getByText('Add the number customers can call')).toBeTruthy();
    expect(screen.getAllByText('Add the documents it still needs, under Documents')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: "Finish in Royal East's Settings" })).toBeNull();
    // [OPEN-EARLY PR-2] documents are sent on this website: a documents-only branch gets its Documents button, no Settings one
    expect(screen.getByText('Royal South · not live yet: finish setting it up')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Finish in Royal South's Settings" })).toBeNull();
    expect(screen.getByRole('button', { name: "Open Royal South's Documents" })).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Open Royal East's Documents" })).toBeNull();
    await user.click(screen.getByRole('button', { name: "Finish in Royal West's Settings" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/dashboard/settings'));
    expect((await import('@/lib/auth')).getSelectedStore()).toBe('west');
  });

  // [OPEN-EARLY PR-2] A branch waiting for its documents: the button opens THAT branch's Documents on the website.
  it('a branch waiting for its documents opens its own Documents page', async () => {
    api();
    const { user } = renderWithQuery(<BranchesPage />);
    await user.click(await screen.findByRole('button', { name: "Open Royal South's Documents" }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/dashboard/documents'));
    expect((await import('@/lib/auth')).getSelectedStore()).toBe('south');
  });

  it('several branches at once offers live branches only (REVIEW-F N1)', async () => {
    api();
    renderWithQuery(<BranchesPage />);
    expect(await screen.findByRole('checkbox', { name: /Royal North/ })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /Royal East/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Royal West/ })).toBeNull();
  });

  it('a manager (perhaps at two businesses) sees "N stores", never "One business" (REVIEW-F S4-2)', async () => {
    api({ role: 'MANAGER' });
    renderWithQuery(<BranchesPage />);
    expect(await screen.findByText('5 stores')).toBeTruthy();
    expect(screen.queryByText(/One business/)).toBeNull();
    expect(screen.queryByText('Not live yet')).toBeNull();
  });

  it('staff do not see the branches', async () => {
    api({ role: 'STAFF' });
    renderWithQuery(<BranchesPage />);
    expect(await screen.findByText("Branches are for the store's owner and managers.")).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Add a branch' })).toBeNull();
  });
});
