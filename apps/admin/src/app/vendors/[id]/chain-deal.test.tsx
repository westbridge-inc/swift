import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VendorDetailPage from './page';
import { API_ORIGIN, fulfilledParams, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// [CHAINS · owner 29 Oct 2026] The founder sets a negotiated weekly fee for every branch of one owner from the store
// page. The panel says the deal never raises a branch's fee and applies from the next weekly fee; the amount and the
// reason go to the owner's deal route (a second admin approves it on the server).
const vendor = {
  id: 'vendor-target', name: 'Royal North', status: 'ACTIVE', vendorType: 'RESTAURANT', isFeatured: false, acceptingOrders: true,
  city: 'Georgetown', addressLine1: 'Test address', phone: 'test-phone', averageRating: null, totalRatings: 0, mmgPayUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z', recentOrders: [], subscription: null, _count: { items: 0, orders: 0 },
  owner: {
    id: 'owner-row-1', dealWeeklyRate: null, dealSetAt: null,
    user: { id: 'owner-1', firstName: 'Chain', lastName: 'Head', phone: 'owner-phone', email: null, status: 'ACTIVE' },
    vendors: [{ id: 'vendor-target', name: 'Royal North', status: 'ACTIVE' }, { id: 'vendor-2', name: 'Royal Camp', status: 'ACTIVE' }],
  },
};
const checklist = {
  vendorId: 'vendor-target', applicantId: 'owner-1', storeStatus: 'ACTIVE', suspensionSource: null, ownerAccountStatus: 'ACTIVE',
  isVerified: true, activationValidUntil: null, role: 'RESTAURANT', checklist: { complete: true, items: [] },
  disclosure: { engaged: false, complete: true, missing: [] }, ready: true, next: 'LIVE',
};

describe('[CHAINS] chain deal on the store page', () => {
  it('explains the deal, then sends the amount and the reason for this owner', async () => {
    const fetchMock = mockApi((request: ApiRequest) => {
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') return { body: { success: true, data: vendor } };
      if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target/activation-checklist') return { body: { success: true, data: checklist } };
      if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/vendor-owners/owner-row-1/deal-rate') {
        return { body: { success: true, data: { dealWeeklyRate: 14000, currencyCode: 'GYD', branches: [
          { vendorId: 'vendor-target', vendorName: 'Royal North', from: 20000, to: 14000, outcome: 'APPLIED' },
          { vendorId: 'vendor-2', vendorName: 'Royal Camp', from: 12000, to: 12000, outcome: 'OWN_FEE_LOWER' },
        ] } } };
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    expect((await screen.findByRole('heading', { name: 'Chain deal' })).parentElement?.textContent).toContain('each branch pays its own weekly fee');
    await user.click(screen.getByRole('button', { name: 'Set chain deal…' }));
    const dialog = screen.getByRole('dialog', { name: 'Set a chain deal for Chain Head?' });
    expect(dialog.textContent).toContain('unless its own fee is already lower');
    expect(dialog.textContent).toContain('Weeks already paid keep their price');
    await user.type(within(dialog).getByRole('textbox', { name: /Weekly fee per branch/i }), '14000');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Head office agreement signed 29 Oct');
    await user.click(within(dialog).getByRole('button', { name: 'Set chain deal' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/vendor-owners/owner-row-1/deal-rate`);
    expect(JSON.parse(String(init?.body))).toEqual({ weeklyRate: 14000, reason: 'Head office agreement signed 29 Oct' });
    expect((await screen.findByRole('status')).textContent).toContain('1 branch(es) changed, 1 already pay less');
  });
});

// [ENTERPRISE E2 · owner 29 Oct 2026] Ending or raising a deal raises the branches' fees: the panel says each branch is
// told in the app at least 14 days ahead, and sends the kind, the end date and the reason to the owner's deal-change route.
describe('[E2] ending, raising and withdrawing a chain deal', () => {
  const onDeal = { ...vendor, owner: { ...vendor.owner, dealWeeklyRate: '14000', dealSetAt: '2026-10-29T12:00:00.000Z', dealChangeKind: null } };
  const routes = (data: unknown) => (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') return { body: { success: true, data } };
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target/activation-checklist') return { body: { success: true, data: checklist } };
    if (request.url.pathname === '/api/v1/admin/vendor-owners/owner-row-1/deal-change') {
      return { body: { success: true, data: request.method === 'DELETE' ? { droppedRises: 1 } : { kind: 'END', dealFrom: 14000, dealTo: null, notBefore: '2026-12-01T04:00:00.000Z', branches: [
        { vendorId: 'vendor-target', vendorName: 'Royal North', from: 14000, to: 20000, outcome: 'WAITING' },
        { vendorId: 'vendor-2', vendorName: 'Royal Camp', from: 12000, to: 12000, outcome: 'LEFT_DEAL' },
      ] } } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  it('end deal: says the 14-day notice, then sends END with the end date (start of that day in Guyana) and the reason', async () => {
    const fetchMock = mockApi(routes(onDeal));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await user.click(await screen.findByRole('button', { name: 'End chain deal…' }));
    const dialog = screen.getByRole('dialog', { name: 'End the chain deal for Chain Head?' });
    expect(dialog.textContent).toContain('told in the app at least 14 days ahead');
    expect(dialog.textContent).toContain('Weeks already paid keep their price');
    await user.type(within(dialog).getByRole('textbox', { name: /End date/i }), '2026-12-01');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Head office deal ends as signed');
    await user.click(within(dialog).getByRole('button', { name: 'End chain deal' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'POST')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'POST')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/vendor-owners/owner-row-1/deal-change`);
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'END', notBefore: '2026-12-01T04:00:00.000Z', reason: 'Head office deal ends as signed' });
    expect((await screen.findByRole('status')).textContent).toContain('1 will be told 14 days before the end date, 1 already pay their own fee');
  });

  it('a pending change is shown and can be withdrawn; no raise or end is offered beside it', async () => {
    const pending = { ...onDeal, owner: { ...onDeal.owner, dealChangeKind: 'RAISE', dealChangeTo: '17000', dealChangeNotBefore: '2026-12-01T04:00:00.000Z', dealChangeSwitchedAt: null } };
    const fetchMock = mockApi(routes(pending));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    const panel = (await screen.findByRole('heading', { name: 'Chain deal' })).parentElement!;
    expect(panel.textContent).toContain('The deal goes up to G$17,000 a week');
    expect(screen.queryByRole('button', { name: 'Raise chain deal…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End chain deal…' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Withdraw change…' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Head office renewed the deal');
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw change' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'DELETE')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'DELETE')[0]![1]?.body))).toEqual({ reason: 'Head office renewed the deal' });
  });
});
