import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VendorDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [BUG-HUNT F22] What the screens tell a store to ask support for: a type picked by mistake, a checked name.
const REASON = 'The owner picked the wrong type when signing up';
const store = (extra: Record<string, unknown> = {}) => ({
  id: 'vendor-target', name: 'Target Store', status: 'PENDING_APPROVAL', vendorType: 'RESTAURANT', isFeatured: false, acceptingOrders: false,
  city: 'Georgetown', addressLine1: 'Test address', phone: 'test-phone', averageRating: 5, totalRatings: 0, mmgPayUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z', recentOrders: [], subscription: null, firstLiveAt: null, tier: 'REGISTERED',
  owner: { user: { id: 'owner-1', firstName: 'Store', lastName: 'Owner', phone: 'owner-phone', email: null, status: 'ACTIVE' }, vendors: [] },
  _count: { items: 0, orders: 0 }, ...extra,
});
const checklist = {
  vendorId: 'vendor-target', applicantId: 'owner-1', storeStatus: 'PENDING_APPROVAL', suspensionSource: null, ownerAccountStatus: 'ACTIVE', isVerified: false, activationValidUntil: null,
  role: 'RESTAURANT', checklist: { complete: false, items: [] }, disclosure: { engaged: false, complete: true, missing: [] }, ready: false, next: 'NEEDS_DOCUMENTS',
};

function serve(data: unknown) {
  return mockApi((request) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') return { body: { success: true, data } };
    if (request.method === 'GET' && request.url.pathname.endsWith('/activation-checklist')) return { body: { success: true, data: checklist } };
    if (request.method === 'PUT') return { body: { success: true, data: {} } };
    return { body: { success: true, data: [] } };
  });
}

describe('[BUG-HUNT F22] the store page', () => {
  it('changes a type picked by mistake, with a reason, and never offers the type it already has', async () => {
    const fetchMock = serve(store());
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await user.click(await screen.findByRole('button', { name: 'Change type…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the type of Target Store?' });
    expect(within(dialog).queryByRole('radio', { name: 'Restaurant' })).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Store' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Change type' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toMatch(/\/vendors\/vendor-target\/type$/);
    expect(JSON.parse(String(init?.body))).toEqual({ vendorType: 'STORE' });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it.each([[{ firstLiveAt: '2026-10-01T00:00:00.000Z' }], [{ subscription: { id: 's1', status: 'TRIAL' } }]])('does not offer a type change on a store that has been live: %j', async (extra) => {
    serve(store(extra));
    renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await screen.findByRole('button', { name: 'Change name…' });
    expect(screen.queryByRole('button', { name: 'Change type…' })).toBeNull();
  });

  it('changes a checked name, with how it was checked', async () => {
    const fetchMock = serve(store({ firstLiveAt: '2026-10-01T00:00:00.000Z', status: 'ACTIVE' }));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);
    await user.click(await screen.findByRole('button', { name: 'Change name…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the name of Target Store?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'New store name' }), 'Corner Kitchen');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Checked the new registration certificate');
    await user.click(within(dialog).getByRole('button', { name: 'Change name' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toMatch(/\/vendors\/vendor-target\/name$/);
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Corner Kitchen' });
  });
});
