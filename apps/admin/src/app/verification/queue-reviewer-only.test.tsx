import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, requestsByMethod, type ApiRequest } from '@/test/test-utils';

// [DOC-SECURITY G3] The review queue is a document reviewer's read: the server
// answers 403 DOCUMENT_REVIEWER_REQUIRED to an admin without the grant (`*`
// never confers it). The Review Center says so, in words, instead of calling a
// refusal "could not be loaded"; and a super-admin who grants themselves the
// permission sees the queue at once, without a reload.

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const REASON = 'Owner reviews launch documents himself this week';
const REFUSAL = { status: 403, body: { success: false, error: { code: 'DOCUMENT_REVIEWER_REQUIRED', message: 'You need the document-reviewer permission to open or decide documents.' } } };
const waiting = {
  id: 'doc-1', userId: 'u1', docType: 'national_id', role: 'MOVER', status: 'PENDING', createdAt: '2026-10-01T00:00:00Z',
  user: { id: 'u1', firstName: 'Queued', lastName: 'Applicant', phone: '+592•••••7001', countryCode: 'GY' },
};

function handler(state: { granted: boolean; superAdmin: boolean }) {
  return (r: ApiRequest) => {
    if (r.url.pathname === '/api/v1/admin/verification/queue/counts') return { body: { success: true, data: { byStatus: { PENDING: 1 }, byLane: { PENDING: { operator: 1, customer: 0 } } } } };
    if (r.url.pathname === '/api/v1/admin/verification/queue') {
      if (!state.granted) return REFUSAL;
      return { body: { success: true, data: r.url.searchParams.get('status') === 'PENDING' ? [waiting] : [], meta: { hasNext: false } } };
    }
    if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') {
      if (!state.superAdmin) return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Founder access required' } } };
      return { body: { success: true, data: [{ userId: 'usr_me', name: 'Synthetic Owner', role: 'SUPER_ADMIN', active: true, documentReviewer: state.granted, catalogueApprover: false, you: true }] } };
    }
    if (r.url.pathname === '/api/v1/admin/staff/catalogue-approvers') return { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'Founder access required' } } };
    if (r.method === 'PUT' && r.url.pathname === '/api/v1/admin/staff/usr_me/document-reviewer') {
      state.granted = true;
      return { body: { success: true, data: { userId: 'usr_me', documentReviewer: true, changed: true } } };
    }
    return { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: `No fixture for ${r.method} ${r.url.pathname}` } } };
  };
}

describe('[DOC-SECURITY G3] the queue without the document-reviewer permission', () => {
  it('says the permission is needed, never that the queue could not be loaded, and lists no one', async () => {
    mockApi(handler({ granted: false, superAdmin: false }));
    renderWithQuery(<VerificationPage />);
    const notice = await screen.findByRole('status', { name: 'Document-reviewer permission needed' });
    expect(within(notice).getByText(/You need the document-reviewer permission to see the documents waiting for review/)).toBeTruthy();
    expect(within(notice).getByText(/A super-admin grants it/)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
    expect(screen.queryByText('Queued Applicant')).toBeNull();
  });

  it('a super-admin who grants themselves the permission sees the queue straight away', async () => {
    const state = { granted: false, superAdmin: true };
    const fetchMock = mockApi(handler(state));
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findByRole('status', { name: 'Document-reviewer permission needed' });
    const panel = await screen.findByRole('region', { name: 'Document reviewers' });
    await user.click(within(panel).getByRole('button', { name: 'Grant myself the document-reviewer permission' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), REASON);
    await user.click(within(dialog).getByRole('button', { name: 'Grant permission' }));
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    expect(await screen.findByText('Queued Applicant')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Document-reviewer permission needed' })).toBeNull();
  });
});
