import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import VendorDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] A store's VAT on its own admin page: where it stands, what a person approved, and the one
// action an approved store's VAT has here — withdraw it (e.g. the GRA cancelled the registration), with a reason the
// owner reads. A store that never claimed VAT shows no VAT section. Synthetic store only.
// ---------------------------------------------------------------------------

const REASON = 'The GRA cancelled this business registration for VAT this month';
const base = {
  id: 'vendor-vat', name: 'Sample Shop', status: 'ACTIVE', vendorType: 'SUPERMARKET', isFeatured: false, acceptingOrders: true,
  city: 'Georgetown', addressLine1: 'Test address', phone: 'test-phone', averageRating: null, totalRatings: 0, mmgPayUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z', recentOrders: [], subscription: null, _count: { items: 0, orders: 0 },
  owner: { user: { id: 'owner-1', firstName: 'Store', lastName: 'Owner', phone: 'owner-phone', email: null, status: 'ACTIVE' }, vendors: [{ id: 'vendor-vat', name: 'Sample Shop', status: 'ACTIVE' }] },
  vatStatus: 'NONE', vatRegistrationNumber: null, vatApprovedNumber: null, vatApprovedName: null, vatEffectiveFrom: null, vatReviewNote: null,
};
const checklist = {
  vendorId: 'vendor-vat', applicantId: 'owner-1', storeStatus: 'ACTIVE', suspensionSource: null, ownerAccountStatus: 'ACTIVE', isVerified: true,
  activationValidUntil: null, role: 'SUPERMARKET', checklist: { complete: true, items: [] }, disclosure: { engaged: false, complete: true, missing: [] }, ready: true, next: 'LIVE',
};

function serve(vendor: Record<string, unknown>, writes: ApiRequest[] = []) {
  return mockApi((r) => {
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/vendors/vendor-vat') return { body: { success: true, data: vendor } };
    if (r.method === 'GET' && r.url.pathname === '/api/v1/admin/vendors/vendor-vat/activation-checklist') return { body: { success: true, data: checklist } };
    if (r.method === 'POST') { writes.push(r); return { body: { success: true, data: { status: 'REVOKED' } } }; }
    if (r.method === 'GET') return { body: { success: true, data: [] } };
    throw new Error(`Unexpected request: ${r.method} ${r.url}`);
  });
}

describe('[O-5] a store’s VAT on its admin page', () => {
  it('a store that never claimed VAT has no VAT section', async () => {
    serve(base);
    renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-vat' })} />);
    expect(await screen.findByRole('heading', { name: 'Store' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'VAT' })).toBeNull();
  });

  it('a pending store points to the Store VAT queue; nothing to withdraw', async () => {
    serve({ ...base, vatStatus: 'PENDING', vatRegistrationNumber: '012345678' });
    renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-vat' })} />);
    const section = (await screen.findByRole('heading', { name: 'VAT' })).closest('section')!;
    expect(within(section).getByText('Waiting for a person to check its GRA certificate')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'Decide it in Store VAT' }).getAttribute('href')).toBe('/store-vat');
    expect(within(section).queryByRole('button', { name: 'Withdraw VAT' })).toBeNull();
  });

  it('an approved store shows what the person approved, and withdrawing it sends the reason the owner reads', async () => {
    const user = userEvent.setup();
    const writes: ApiRequest[] = [];
    serve({ ...base, vatStatus: 'APPROVED', vatRegistrationNumber: '012345678', vatApprovedNumber: '012345678', vatApprovedName: 'Sample Shop Ltd', vatEffectiveFrom: '2026-01-01T00:00:00.000Z' }, writes);
    renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-vat' })} />);
    const section = (await screen.findByRole('heading', { name: 'VAT' })).closest('section')!;
    expect(within(section).getByText('Sample Shop Ltd')).toBeTruthy();
    expect(within(section).getByText('2026-01-01')).toBeTruthy();
    await user.click(within(section).getByRole('button', { name: 'Withdraw VAT' }));
    const dialog = screen.getByRole('dialog', { name: 'Withdraw VAT for Sample Shop?' });
    await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw VAT' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url.pathname).toBe('/api/v1/admin/store-vat/vendor-vat/revoke');
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({ reason: REASON });
    expect((writes[0]!.init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });
});
