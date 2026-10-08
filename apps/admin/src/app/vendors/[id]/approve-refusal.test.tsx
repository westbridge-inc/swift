import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import VendorDetailPage from './page';
import {
  fulfilledParams,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiRequest,
} from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-1] "Approving a store silently didn't work."
//
// The server refused with 409 CHECKLIST_INCOMPLETE — "approve the documents in
// Verification first" — and the page threw the answer away: the approve
// mutation had no error branch and nothing rendered it. These tests hold the
// fix at the page: the refusal arrives in plain words, with the next step and
// a link to the Review Center for the store's OWNER (the person whose
// documents gate the store), and the server's code stays visible for support.
//
// The reason is supplied through whichever surface the page offers. At the
// old main that was a browser prompt (stubbed below); now it is the in-page
// panel, which `giveReason` fills. The assertions are the same either way.
//
// [MC-PR2] The button is "Activate now…" and appears only when the server's
// checklist verdict says every rule is met (CAN_ACTIVATE). The refusal can
// still happen — the documents can change between reading the checklist and
// pressing the button — and it must still arrive in words.
// ---------------------------------------------------------------------------

const REASON = 'Checked the owner ID and the food licence against the originals';

const pendingStore = {
  id: 'vendor-target',
  name: 'Target Store',
  status: 'PENDING_APPROVAL',
  vendorType: 'RESTAURANT',
  isFeatured: false,
  acceptingOrders: false,
  city: 'Georgetown',
  addressLine1: 'Test address',
  phone: 'test-phone',
  averageRating: 5,
  totalRatings: 0,
  mmgPayUrl: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  recentOrders: [],
  subscription: null,
  owner: {
    user: { id: 'owner-1', firstName: 'Store', lastName: 'Owner', phone: 'owner-phone', email: null, status: 'ACTIVE' },
    vendors: [{ id: 'vendor-target', name: 'Target Store', status: 'PENDING_APPROVAL' }],
  },
  _count: { items: 0, orders: 0 },
};

/** The body the API's error handler sends for this AppError (apps/api middleware/error-handler.ts). */
const CHECKLIST_INCOMPLETE = {
  status: 409,
  body: {
    success: false,
    error: {
      code: 'CHECKLIST_INCOMPLETE',
      message: "Target Store's required documents are not all approved and current — review them in the Verification queue first.",
    },
  },
};

/** The server said every rule was met when the page loaded (GET /vendors/:id/activation-checklist). */
const readyChecklist = {
  vendorId: 'vendor-target', applicantId: 'owner-1', storeStatus: 'PENDING_APPROVAL', suspensionSource: null,
  ownerAccountStatus: 'ACTIVE', isVerified: false, activationValidUntil: null, role: 'RESTAURANT',
  checklist: { complete: true, items: [{ docType: 'owner_national_id', state: 'APPROVED', documentId: 'd1', submittedAt: null, expiresAt: null, note: null, renewalPending: false }] },
  disclosure: { engaged: false, complete: true, missing: [] }, ready: true, next: 'CAN_ACTIVATE',
};

function handler(onApprove: () => { status?: number; body: unknown }) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target') {
      return { body: { success: true, data: pendingStore } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/vendors/vendor-target/activation-checklist') {
      return { body: { success: true, data: readyChecklist } };
    }
    if (request.method === 'PUT' && request.url.pathname === '/api/v1/admin/vendors/vendor-target/approve') {
      return onApprove();
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

/** Answer the page's question for a reason, wherever the page asks it. */
async function giveReason(user: UserEvent, reason: string) {
  const dialog = screen.queryByRole('dialog');
  if (!dialog) return; // the page asked through the browser (stubbed in the test)
  await user.type(within(dialog).getByRole('textbox', { name: /reason/i }), reason);
  await user.click(within(dialog).getByRole('button', { name: /^Activate/ }));
}

describe('[MC-PR1] approving a store whose documents are not all approved', () => {
  it('shows the refusal in plain words, the next step, a Review Center link for the owner, and the code for support', async () => {
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    vi.stubGlobal('prompt', vi.fn().mockReturnValue(REASON));
    const fetchMock = mockApi(handler(() => CHECKLIST_INCOMPLETE));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);

    await user.click(await screen.findByRole('button', { name: /^Activate now/ }));
    await giveReason(user, REASON);

    const title = await screen.findByText('Approve the required documents in Verification first');
    // the refusal's own link (the checklist panel on the page has one too [MC-PR2])
    const link = within(title.closest('[role=alert]') as HTMLElement).getByRole('link', { name: 'Open in Review Center' });
    expect(link.getAttribute('href')).toBe('/verification?applicant=owner-1');
    // the server's own sentence (which store) and its code stay on screen
    expect(screen.getByText(/required documents are not all approved and current/)).toBeTruthy();
    expect(screen.getByText(/CHECKLIST_INCOMPLETE/)).toBeTruthy();

    const puts = requestsByMethod(fetchMock, 'PUT');
    expect(puts).toHaveLength(1);
    expect((puts[0]![1]?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
  });

  it('asks for the reason in the page — never a browser prompt or confirm', async () => {
    const confirm = vi.fn().mockReturnValue(true);
    const prompt = vi.fn().mockReturnValue(REASON);
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal('prompt', prompt);
    const fetchMock = mockApi(handler(() => CHECKLIST_INCOMPLETE));
    const { user } = renderWithQuery(<VendorDetailPage params={fulfilledParams({ id: 'vendor-target' })} />);

    await user.click(await screen.findByRole('button', { name: /^Activate now/ }));
    await giveReason(user, REASON);

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(confirm).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});
