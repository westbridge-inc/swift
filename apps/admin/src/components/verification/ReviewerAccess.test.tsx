import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewerAccess } from './ReviewerAccess';
import { DocumentViewer } from './DocumentViewer';
import { mockApi, renderWithQuery, requestsByMethod } from '@/test/test-utils';

// [VERIFY-DOCS V3] Owner ruling (6 Oct): opening, approving and rejecting a
// document need an explicit document-reviewer grant; a super-admin may grant it
// to themselves with a recorded reason; after the update the owner grants
// himself once before reviewing. The API has the grant route; these tests pin
// the console door to it, so the refusal never points at a screen that is not
// there.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const REASON = 'Owner reviews launch documents himself this week';
const team = (meGranted: boolean) => [
  { userId: 'usr_me', name: 'Synthetic Owner', role: 'SUPER_ADMIN', active: true, documentReviewer: meGranted, you: true },
  { userId: 'usr_ops', name: 'Synthetic Operator', role: 'ADMIN', active: true, documentReviewer: true, you: false },
  { userId: 'usr_gone', name: 'Synthetic Former', role: 'ADMIN', active: false, documentReviewer: false, you: false },
];

describe('[VERIFY-DOCS V3] the document reviewer grant in the Review Center', () => {
  it('stays hidden from an admin the list refuses (only a super-admin manages the grant)', async () => {
    const fetchMock = mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') {
        return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Founder access required' } } };
      }
      throw new Error(`Unexpected ${r.url.pathname}`);
    });
    renderWithQuery(<ReviewerAccess />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Document reviewers' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Grant/ })).toBeNull();
  });

  it('a super-admin without the grant is told so and grants it to themselves with a stated reason', async () => {
    let granted = false;
    const fetchMock = mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') return { body: { success: true, data: team(granted) } };
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/staff/usr_me/document-reviewer') {
        granted = true;
        return { body: { success: true, data: { userId: 'usr_me', documentReviewer: true, changed: true } } };
      }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<ReviewerAccess />);
    const panel = await screen.findByRole('region', { name: 'Document reviewers' });
    expect(within(panel).getByText(/You cannot open, approve or reject documents yet/)).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Grant myself the document-reviewer permission' }));

    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Grant permission' }));

    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(String(url)).toBe('http://admin-api.test/api/v1/admin/staff/usr_me/document-reviewer');
    expect(JSON.parse(String(init?.body))).toEqual({ grant: true });
    expect((init?.headers as Record<string, string>)['x-swift-reason']).toBe(REASON);
    // The list is read again from the server: no optimistic "granted".
    expect(await within(panel).findByText(/You can open, approve and reject documents/)).toBeTruthy();
  });

  it('removing it from a colleague also needs a reason; a refusal is shown and nothing is claimed', async () => {
    const fetchMock = mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') return { body: { success: true, data: team(true) } };
      if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/staff/usr_ops/document-reviewer') {
        return { status: 409, body: { success: false, error: { code: 'NOT_ACTIVE_STAFF', message: 'Only an active admin of this team can hold the document-reviewer permission.' } } };
      }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<ReviewerAccess />);
    const panel = await screen.findByRole('region', { name: 'Document reviewers' });
    const row = within(panel).getByText('Synthetic Operator').closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Remove the permission from Synthetic Operator' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Moved to support duties from Monday on');
    await user.click(within(dialog).getByRole('button', { name: 'Remove permission' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ grant: false });
    expect(await within(dialog).findByText(/Only an active admin of this team/)).toBeTruthy();
  });

  it('an inactive admin is listed without a grant button', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') return { body: { success: true, data: team(true) } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    renderWithQuery(<ReviewerAccess />);
    const panel = await screen.findByRole('region', { name: 'Document reviewers' });
    const row = within(panel).getByText('Synthetic Former').closest('li')!;
    expect(within(row).getByText(/inactive/i)).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
  });
});

describe('[VERIFY-DOCS V3] the document viewer names the grant when it is missing', () => {
  it('shows who grants the permission and where, not "try again"', async () => {
    const message = 'You need the document-reviewer permission to open or decide documents. A super-admin grants it under Document reviewers at the top of the Review Center.';
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/verification/doc_1/document-url') {
        return { status: 403, body: { success: false, error: { code: 'DOCUMENT_REVIEWER_REQUIRED', message } } };
      }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<DocumentViewer id="doc_1" label="National ID" onViewed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'View document' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).not.toMatch(/Try View document again/);
  });
});

describe('[VERIFY-DOCS V3 · DS1003 S4] a grant revoked after the link was minted', () => {
  it('the render refusal names the grant too, not "try again"', async () => {
    const message = 'You need the document-reviewer permission to open or decide documents. A super-admin grants it under Document reviewers at the top of the Review Center.';
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/verification/doc_2/document-url') {
        return { body: { success: true, data: { url: '/api/v1/verification/render/doc_2?expires=9999999999&reviewer=rev&sig=synthetic-signature-0000', expiresInSeconds: 300 } } };
      }
      if (r.url.pathname === '/api/v1/verification/render/doc_2') {
        return { status: 403, body: { success: false, error: { code: 'DOCUMENT_REVIEWER_REQUIRED', message } } };
      }
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    const { user } = renderWithQuery(<DocumentViewer id="doc_2" label="National ID" onViewed={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'View document' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).not.toMatch(/Try View document again/);
  });
});

describe('[VERIFY-DOCS V3] the Review Center carries the panel', () => {
  it('a super-admin sees Document reviewers above the queue', async () => {
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
    const { default: VerificationPage } = await import('@/app/verification/page');
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') return { body: { success: true, data: team(false) } };
      if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: {} } } };
      if (r.url.pathname.endsWith('/queue')) return { body: { data: [], meta: { hasNext: false } } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    renderWithQuery(<VerificationPage />);
    const panel = await screen.findByRole('region', { name: 'Document reviewers' });
    expect(within(panel).getByRole('button', { name: 'Grant myself the document-reviewer permission' })).toBeTruthy();
  });
});
