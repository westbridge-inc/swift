import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import UsersPage from './users/page';
import VendorsPage from './vendors/page';
import RidersPage from './riders/page';
import DriversPage from './drivers/page';
import OrdersPage from './orders/page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3] Lists that work.
//
// Every list used to ask for page 1 of 20 and nothing else: no search, no
// filter, no pager, test data counted as real, phones in full, enums printed,
// and a failed read shown as an empty table. Each list now asks the server for
// a page, a search and its filters, hides test data unless asked, and shows the
// server's count.
// ---------------------------------------------------------------------------

const meta = (page: number, total: number, limit = 25) => ({ page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total, hasPrev: page > 1 });

const people = [
  { id: 'u1', firstName: 'Real', lastName: 'Person', phone: '+5926123456', email: 'real@example.gy', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true, createdAt: '2026-09-01T00:00:00Z', lastActiveAt: null, avatar: null },
];

function lastQuery(fetchMock: ReturnType<typeof mockApi>, path: string): URLSearchParams {
  const calls = requestsByMethod(fetchMock, 'GET').map(([u]) => new URL(String(u))).filter((u) => u.pathname === path);
  return calls.at(-1)!.searchParams;
}

describe('[MC-PR3] the people list asks the server for a page, a search and filters', () => {
  it('first page of 25 with test data hidden; search, filters and "Show test data" reach the server; the pager follows its count', async () => {
    const fetchMock = mockApi((r: ApiRequest) => ({ body: { success: true, data: people, meta: meta(Number(r.url.searchParams.get('page') ?? 1), 60) } }));
    const { user } = renderWithQuery(<UsersPage />);
    await screen.findByRole('table', { name: 'People' });
    let q = lastQuery(fetchMock, '/api/v1/admin/users');
    expect(Object.fromEntries(q)).toEqual({ page: '1', limit: '25', excludeFixtures: 'true' });
    expect(screen.getByText('Showing 1–1 of 60')).toBeTruthy();

    await user.type(screen.getByRole('searchbox', { name: 'Search by name, phone or email' }), 'real');
    await waitFor(() => expect(lastQuery(fetchMock, '/api/v1/admin/users').get('search')).toBe('real'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'VENDOR_OWNER');
    await user.click(screen.getByRole('checkbox', { name: 'Show test data' }));
    await waitFor(() => {
      q = lastQuery(fetchMock, '/api/v1/admin/users');
      expect(Object.fromEntries(q)).toEqual({ page: '1', limit: '25', search: 'real', role: 'VENDOR_OWNER' });
    });

    await user.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(lastQuery(fetchMock, '/api/v1/admin/users').get('page')).toBe('2'));
    expect(await screen.findByText('Page 2 of 3')).toBeTruthy();
  });

  it('[security review] says how many test records it hid, with a way to show them — nothing leaves silently', async () => {
    const fetchMock = mockApi((r: ApiRequest) => ({ body: { success: true, data: people, meta: { ...meta(1, 1), hiddenTestRecords: r.url.searchParams.get('excludeFixtures') === 'true' ? 7 : 0 } } }));
    const { user } = renderWithQuery(<UsersPage />);
    expect(await screen.findByText(/7 test records hidden/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(lastQuery(fetchMock, '/api/v1/admin/users').get('excludeFixtures')).toBeNull());
    expect((screen.getByRole('checkbox', { name: 'Show test data' }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(screen.queryByText(/test records hidden/)).toBeNull());
  });

  it('shows roles and statuses in words and phones masked — the full number is on the person’s page', async () => {
    mockApi(() => ({ body: { success: true, data: people, meta: meta(1, 1) } }));
    renderWithQuery(<UsersPage />);
    const table = await screen.findByRole('table', { name: 'People' });
    expect(within(table).getByText('Business owner')).toBeTruthy();
    expect(within(table).getByText('Active')).toBeTruthy();
    expect(within(table).getByText('••• ••• 3456')).toBeTruthy();
    expect(table.textContent).not.toMatch(/\+5926123456|VENDOR_OWNER|ACTIVE/);
  });

  it('a refused suspension (role hierarchy, 403) is shown in words, not swallowed', async () => {
    mockApi((r) => (r.method === 'GET'
      ? { body: { success: true, data: people, meta: meta(1, 1) } }
      : { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'An admin cannot suspend another admin.' } } }));
    const { user } = renderWithQuery(<UsersPage />);
    await user.click(await screen.findByRole('button', { name: 'Suspend Real Person…' }));
    const dialog = screen.getByRole('dialog', { name: 'Suspend Real Person?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Repeated chargebacks after three written warnings');
    await user.click(within(dialog).getByRole('button', { name: 'Suspend account' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain("You don't have permission to do this");
    expect(alert.textContent).toContain('An admin cannot suspend another admin.');
  });

  it('a failed read is "Couldn’t load the people list" with a Retry — never an empty table', async () => {
    mockApi(() => ({ status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } }));
    renderWithQuery(<UsersPage />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the people list");
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('[MC-PR3] stores, riders, drivers and orders lists', () => {
  it('stores: status and type filters reach the server', async () => {
    const fetchMock = mockApi(() => ({ body: { success: true, data: [], meta: meta(1, 0) } }));
    const { user } = renderWithQuery(<VendorsPage />);
    await screen.findByRole('table', { name: 'Stores' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'PENDING_APPROVAL');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'SUPERMARKET');
    await waitFor(() => expect(Object.fromEntries(lastQuery(fetchMock, '/api/v1/admin/vendors'))).toEqual({ page: '1', limit: '25', status: 'PENDING_APPROVAL', type: 'SUPERMARKET', excludeFixtures: 'true' }));
    expect(screen.getByText('No store matches this search.')).toBeTruthy();
  });

  it('riders: words for the work, masked phones, and a document link instead of a blind Verify', async () => {
    mockApi(() => ({ body: { success: true, data: [{ id: 'r1', riderType: 'BOTH', isOnline: true, documentsVerified: false, averageRating: 5, totalRatings: 0, user: { firstName: 'Ride', lastName: 'Person', phone: '+5926554433' } }], meta: meta(1, 1) } }));
    renderWithQuery(<RidersPage />);
    const table = await screen.findByRole('table', { name: 'Riders' });
    expect(within(table).getByText('Delivery and courier')).toBeTruthy();
    expect(within(table).getByText('••• ••• 4433')).toBeTruthy();
    expect(within(table).getByText('New')).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'Check documents' }).getAttribute('href')).toBe('/riders/r1');
    expect(within(table).queryByRole('button')).toBeNull();
  });

  it('drivers: a ride-class change asks why in the page and its answer is shown', async () => {
    const fetchMock = mockApi((r) => (r.method === 'GET'
      ? { body: { success: true, data: [{ id: 'd1', isOnline: false, documentsVerified: true, rideClass: 'ECONOMY', vehicleMake: 'Toyota', vehicleModel: 'Axio', averageRating: 4.8, totalRatings: 30, totalTrips: 30, user: { firstName: 'Drive', lastName: 'Person', phone: '+5926001122' } }], meta: meta(1, 1) } }
      : { body: { success: true, data: {} } }));
    const { user } = renderWithQuery(<DriversPage />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Ride class for Drive Person' }), 'COMFORT');
    const dialog = screen.getByRole('dialog', { name: "Set Drive Person's ride class to Estate?" });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'The car is a station wagon with full boot space');
    await user.click(within(dialog).getByRole('button', { name: 'Change ride class' }));
    expect((await screen.findByRole('status')).textContent).toContain('Drive Person now drives Estate rides.');
    const [, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ rideClass: 'COMFORT' });
  });

  it('orders: status and type filters and the search reach the server; statuses are words', async () => {
    const fetchMock = mockApi(() => ({ body: { success: true, data: [{ id: 'o1', orderNumber: 'SW-1', orderType: 'TAXI', status: 'RIDE_IN_PROGRESS', paymentMethod: 'CASH', paymentStatus: 'PENDING', totalAmount: 2500, placedAt: '2026-10-01T10:00:00Z', vendor: null, customer: { firstName: 'A', lastName: 'Rider' } }], meta: meta(1, 1) } }));
    const { user } = renderWithQuery(<OrdersPage />);
    const table = await screen.findByRole('table', { name: 'Orders' });
    expect(within(table).getByText('Ride in progress')).toBeTruthy();
    expect(within(table).getByText('Taxi ride')).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'TAXI');
    await user.type(screen.getByRole('searchbox', { name: 'Search by order number or address' }), 'SW-1');
    await waitFor(() => expect(Object.fromEntries(lastQuery(fetchMock, '/api/v1/admin/orders'))).toEqual({ page: '1', limit: '25', type: 'TAXI', search: 'SW-1', excludeFixtures: 'true' }));
  });
});
