import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VendorDetailPage from './page';
import { fulfilledParams, mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-2] THE STORE PAGE SHOWS WHY A STORE IS NOT LIVE.
//
// The manual "Approve" button is gone. The page reads the store's activation
// checklist (GET /vendors/:id/activation-checklist) and shows every required
// document with its state, the reviewer's note on a rejection, the server's
// verdict in one sentence, and a link that opens the owner in the Review
// Center. "Activate now…" and "Reinstate…" appear only when the server's
// verdict says the go-live rules are met.
// ---------------------------------------------------------------------------

const REASON = 'Checked the owner ID and the food licence against the originals';

const item = (docType: string, state: string, extra: Record<string, unknown> = {}) => ({
  docType, state, documentId: state === 'MISSING' ? null : `doc-${docType}`, submittedAt: '2026-10-01T12:00:00.000Z',
  expiresAt: null, note: null, renewalPending: false, ...extra,
});

function storeOf(status: string) {
  return {
    id: 'vendor-target', name: 'Target Store', status, vendorType: 'RESTAURANT', isFeatured: false, acceptingOrders: false,
    city: 'Georgetown', addressLine1: 'Test address', phone: 'test-phone', averageRating: 5, totalRatings: 0, mmgPayUrl: null,
    createdAt: '2026-08-01T00:00:00.000Z', recentOrders: [], subscription: null, tier: 'UNREGISTERED',
    owner: { user: { id: 'owner-1', firstName: 'Store', lastName: 'Owner', phone: 'owner-phone', email: null, status: 'ACTIVE' }, vendors: [] },
    _count: { items: 0, orders: 0 },
  };
}

function checklistOf(next: string, overrides: Record<string, unknown> = {}) {
  return {
    vendorId: 'vendor-target', applicantId: 'owner-1', storeStatus: 'PENDING_APPROVAL', suspensionSource: null, ownerAccountStatus: 'ACTIVE',
    isVerified: false, activationValidUntil: null, role: 'RESTAURANT',
    checklist: {
      complete: next !== 'NEEDS_DOCUMENTS',
      items: next === 'NEEDS_DOCUMENTS'
        ? [
            item('owner_national_id', 'APPROVED'),
            item('gra_restaurant_licence', 'PENDING'),
            item('food_handler_cert', 'REJECTED', { note: 'The certificate is for a different person.' }),
            item('storefront_photo', 'MISSING'),
          ]
        : [item('owner_national_id', 'APPROVED'), item('gra_restaurant_licence', 'APPROVED')],
    },
    disclosure: { engaged: false, complete: true, missing: [] },
    ready: next === 'CAN_ACTIVATE' || next === 'CAN_REINSTATE',
    next,
    ...overrides,
  };
}

function serve(status: string, checklist: unknown, onWrite?: (_r: ApiRequest) => { status?: number; body: unknown }) {
  return mockApi((request) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') return { body: { success: true, data: storeOf(status) } };
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target/activation-checklist') {
      return checklist instanceof Error
        ? { status: 500, body: { success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } } }
        : { body: { success: true, data: checklist } };
    }
    if (onWrite && request.method !== 'GET') return onWrite(request);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

const page = () => renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);

describe('[MC-PR2] a store waiting for documents', () => {
  it('lists every required document with its state and the rejection note, says what happens next, and links the owner in the Review Center', async () => {
    serve('PENDING_APPROVAL', checklistOf('NEEDS_DOCUMENTS'));
    page();
    const panel = await screen.findByRole('region', { name: /Required documents/ });
    expect(within(panel).getByText('1 of 4 approved')).toBeTruthy();
    const rows = within(panel).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toMatch(/National ID.*Approved/);
    expect(rows[1]).toMatch(/GRA restaurant licence.*Waiting for review/);
    expect(rows[2]).toMatch(/Food handler certificate.*Reviewer: The certificate is for a different person\..*Rejected/);
    expect(rows[3]).toMatch(/Storefront photo.*Not sent yet/);
    expect(within(panel).getByText(/When the last required one is approved in the Review Center, Swift makes Target Store live by itself\./)).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open in Review Center' }).getAttribute('href')).toBe('/verification?applicant=owner-1');
    expect(panel.textContent).not.toMatch(/PENDING|REJECTED|MISSING|gra_restaurant/);
    // no manual approval of its own any more
    expect(screen.queryByRole('button', { name: /^(Approve|Activate|Reinstate)/ })).toBeNull();
  });

  it('documents complete but the supplier information incomplete: says which detail is missing, offers nothing to press', async () => {
    serve('PENDING_APPROVAL', checklistOf('NEEDS_DISCLOSURE', { disclosure: { engaged: true, complete: false, missing: ['legalName', 'operator'] }, ready: false }));
    page();
    expect(await screen.findByText(/missing the legal or trading name, Swift's own operator details/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Approve|Activate|Reinstate)/ })).toBeNull();
  });

  it('a checklist that fails to load says so, with a Retry — and offers no activation on a guess', async () => {
    serve('PENDING_APPROVAL', new Error('down'));
    page();
    expect((await screen.findByText("Couldn't load the document checklist")).closest('[role=alert]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Approve|Activate|Reinstate)/ })).toBeNull();
  });
});

describe('[MC-PR2] when the server says the rules are met', () => {
  it('"Activate now…" runs the activation through the reason panel and says the store is live', async () => {
    const fetchMock = serve('PENDING_APPROVAL', checklistOf('CAN_ACTIVATE'), () => ({ body: { success: true, data: { ...storeOf('ACTIVE') } } }));
    const { user } = page();
    await user.click(await screen.findByRole('button', { name: 'Activate now…' }));
    const dialog = screen.getByRole('dialog', { name: 'Activate Target Store now?' });
    expect(dialog.textContent).toContain("Only this store is activated. A valid business registration also promotes the owner's other stores to registered sellers and lifts their unregistered-seller limits.");
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Activate store' }));
    expect((await screen.findByRole('status')).textContent).toContain('Target Store is live and can take orders.');
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toMatch(/\/api\/v1\/admin\/vendors\/vendor-target\/approve$/);
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it('an admin-suspended store with current documents can be reinstated', async () => {
    serve('SUSPENDED', checklistOf('CAN_REINSTATE', { storeStatus: 'SUSPENDED', suspensionSource: 'ADMIN' }));
    page();
    expect(await screen.findByRole('button', { name: 'Reinstate…' })).toBeTruthy();
    expect(screen.getByText('Suspended. Its documents are approved and current, so it can be reinstated.')).toBeTruthy();
  });

  it('a store held for an unpaid weekly fee is not reinstated from here: it comes back when the fee is paid through MMG', async () => {
    serve('SUSPENDED', checklistOf('FEE_UNPAID', { storeStatus: 'SUSPENDED', suspensionSource: 'BILLING', subscriptionStatus: 'SUSPENDED', feeOperable: false, ready: true }));
    page();
    expect(await screen.findByText(/Suspended, and its weekly fee is unpaid or its billing is stopped\. It comes back by itself when the fee is paid through MMG checkout/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Approve|Activate|Reinstate)/ })).toBeNull();
  });

  it('[MC-AD2] the same holds when an admin suspension was laid over the unpaid fee: the server says FEE_UNPAID, the page offers nothing', async () => {
    serve('SUSPENDED', checklistOf('FEE_UNPAID', { storeStatus: 'SUSPENDED', suspensionSource: 'ADMIN', subscriptionStatus: 'CHURNED', feeOperable: false, ready: true }));
    page();
    expect(await screen.findByText(/its weekly fee is unpaid or its billing is stopped/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Approve|Activate|Reinstate)/ })).toBeNull();
    expect(screen.getByText(/After payment, refresh this checklist and reinstate the admin suspension/)).toBeTruthy();
  });

  it('[MC-AD2] a fee paid up but a billing mark left on the store: the server says CAN_REINSTATE, and the page offers it', async () => {
    serve('SUSPENDED', checklistOf('CAN_REINSTATE', { storeStatus: 'SUSPENDED', suspensionSource: 'BILLING', subscriptionStatus: 'ACTIVE', feeOperable: true }));
    page();
    expect(await screen.findByRole('button', { name: 'Reinstate…' })).toBeTruthy();
  });

  it('[MC-AD2] a reinstate the server refuses for an unpaid fee keeps the reason in the panel and says, in words, what lifts it', async () => {
    serve('SUSPENDED', checklistOf('CAN_REINSTATE', { storeStatus: 'SUSPENDED', suspensionSource: 'ADMIN', subscriptionStatus: 'ACTIVE', feeOperable: true }), () => ({
      status: 409,
      body: { success: false, error: { code: 'FEE_UNPAID', message: 'Target Store cannot be reinstated while its weekly fee is unpaid or its weekly billing is stopped. It comes back by itself when the fee is paid through the MMG checkout page; the console cannot lift a fee hold.' } },
    }));
    const { user } = page();
    await user.click(await screen.findByRole('button', { name: 'Reinstate…' }));
    const dialog = screen.getByRole('dialog', { name: 'Reinstate Target Store?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Reinstate store' }));
    expect(await screen.findByText('This store is held by its weekly fee')).toBeTruthy();
    expect(screen.getAllByText(/paid through the MMG checkout page/).length).toBeGreaterThan(0);
  });

  it('a restricted owner must be reinstated before their store', async () => {
    serve('SUSPENDED', checklistOf('OWNER_ACCOUNT_RESTRICTED', { storeStatus: 'SUSPENDED', suspensionSource: 'ADMIN' }));
    page();
    expect(await screen.findByText(/The owner's account is banned or suspended/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^(Approve|Activate|Reinstate)/ })).toBeNull();
  });

  it('the store of an owner who closed their account offers nothing and says why', async () => {
    serve('SUSPENDED', checklistOf('ACCOUNT_CLOSED', { storeStatus: 'SUSPENDED', suspensionSource: 'WIND_DOWN' }));
    page();
    expect(await screen.findByText(/The owner closed their Swift account\. The store stays closed/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /^(Approve|Activate|Reinstate)/ })).toBeNull());
  });
});
