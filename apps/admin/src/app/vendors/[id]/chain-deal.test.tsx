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
