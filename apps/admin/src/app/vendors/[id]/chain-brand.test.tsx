import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VendorDetailPage from './page';
import { API_ORIGIN, fulfilledParams, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// [CHAINS PR3 · owner 29 Oct 2026] One brand card per chain: from the store page a person sets the brand customers see
// once for all of this owner's branches (or removes it), and lists one branch on its own card. Each with a reason.
const vendor = (brandName: string | null) => ({
  id: 'vendor-target', name: 'Royal North', status: 'ACTIVE', vendorType: 'RESTAURANT', isFeatured: false, acceptingOrders: true,
  city: 'Georgetown', addressLine1: 'Test address', phone: 'test-phone', averageRating: null, totalRatings: 0, mmgPayUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z', recentOrders: [], subscription: null, _count: { items: 0, orders: 0 },
  owner: {
    id: 'owner-row-1', dealWeeklyRate: null, dealSetAt: null, brandName,
    user: { id: 'owner-1', firstName: 'Chain', lastName: 'Head', phone: 'owner-phone', email: null, status: 'ACTIVE' },
    vendors: [{ id: 'vendor-target', name: 'Royal North', status: 'ACTIVE' }, { id: 'vendor-2', name: 'Royal Camp', status: 'ACTIVE' }],
  },
});
const checklist = {
  vendorId: 'vendor-target', applicantId: 'owner-1', storeStatus: 'ACTIVE', suspensionSource: null, ownerAccountStatus: 'ACTIVE',
  isVerified: true, activationValidUntil: null, role: 'RESTAURANT', checklist: { complete: true, items: [] },
  disclosure: { engaged: false, complete: true, missing: [] }, ready: true, next: 'LIVE',
};
const chain = (brandName: string | null) => ({ ownerId: 'owner-row-1', brandName, deal: null, branches: [
  { vendorId: 'vendor-target', name: 'Royal North', status: 'ACTIVE', city: 'Georgetown', brandListedAlone: false },
  { vendorId: 'vendor-2', name: 'Royal Camp', status: 'ACTIVE', city: 'Georgetown', brandListedAlone: true },
] });

const api = (brandName: string | null, put: (_request: ApiRequest) => unknown) => mockApi((request: ApiRequest) => {
  if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') return { body: { success: true, data: vendor(brandName) } };
  if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target/activation-checklist') return { body: { success: true, data: checklist } };
  if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendor-owners/owner-row-1/chain') return { body: { success: true, data: chain(brandName) } };
  if (request.method === 'PUT') return { body: { success: true, data: put(request) } };
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
});

describe('[CHAINS] the brand panel on the store page', () => {
  it('no brand yet: sets one with a name and a reason', async () => {
    const fetchMock = api(null, () => ({ ownerId: 'owner-row-1', brandName: 'Royal Castle' }));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    expect((await screen.findByRole('heading', { name: 'Brand' })).parentElement?.textContent).toContain('No brand: each branch is listed on its own.');
    await user.click(screen.getByRole('button', { name: 'Set brand…' }));
    const dialog = screen.getByRole('dialog', { name: "Give Chain Head's branches one brand?" });
    expect(dialog.textContent).toContain('opens the branch that is open and delivers to them');
    await user.type(within(dialog).getByRole('textbox', { name: /Brand name customers see/i }), 'Royal Castle');
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Head office asked on 29 Oct');
    await user.click(within(dialog).getByRole('button', { name: 'Set brand' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/vendor-owners/owner-row-1/brand`);
    expect(JSON.parse(String(init?.body))).toEqual({ brandName: 'Royal Castle', reason: 'Head office asked on 29 Oct' });
  });

  it('with a brand: lists another branch under the brand again (it is listed on its own now)', async () => {
    const fetchMock = api('Royal Castle', () => ({ vendorId: 'vendor-2', brandListedAlone: false }));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    expect((await screen.findByRole('heading', { name: 'Brand' })).parentElement?.textContent).toContain('Customers see "Royal Castle" once');
    await user.click(await screen.findByRole('button', { name: 'List under the brand…' }));
    const dialog = screen.getByRole('dialog', { name: 'List Royal Camp under Royal Castle?' });
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Back under the brand, owner asked');
    await user.click(within(dialog).getByRole('button', { name: 'List under the brand' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/v1/admin/vendors/vendor-2/brand-listing`);
    expect(JSON.parse(String(init?.body))).toEqual({ alone: false, reason: 'Back under the brand, owner asked' });
  });

  it('removes the brand with a reason', async () => {
    const fetchMock = api('Royal Castle', () => ({ ownerId: 'owner-row-1', brandName: null }));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await user.click(await screen.findByRole('button', { name: 'Remove brand…' }));
    const dialog = screen.getByRole('dialog', { name: /Remove the brand Royal Castle\?/ });
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), 'Head office closed the chain');
    await user.click(within(dialog).getByRole('button', { name: 'Remove brand' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(JSON.parse(String(requestsByMethod(fetchMock, 'PUT')[0]![1]?.body))).toEqual({ brandName: null, reason: 'Head office closed the chain' });
  });
});
