import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// [MISSION CONTROL · PR-1] "Open in Review Center" from a refused store approval
// links /verification?applicant=<owner user id>. The link has to land on that
// applicant — a link that opens the whole queue would be a control that looks
// wired and is not.

const doc = (id: string, userId: string, firstName: string) => ({
  id, userId, status: 'PENDING', docType: 'national_id', role: 'VENDOR_OWNER',
  createdAt: '2026-08-01T00:00:00.000Z', consentAt: '2026-08-01T00:00:00.000Z', privacyNoticeVersion: 'test-v1',
  user: { id: userId, firstName, lastName: 'Applicant', phone: `${firstName}-phone`, countryCode: 'GY' },
});

function handler(documents: unknown[]) {
  return (request: ApiRequest) => {
    if (request.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
    if (request.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (request.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (request.url.pathname.endsWith('/document-url')) return { body: { success: true, data: { url: '/api/v1/verification/render/x?expires=1&sig=s' } } };
    if (request.url.pathname.startsWith('/api/v1/verification/render/')) return { body: { loaded: true } };
    if (request.url.pathname === '/api/v1/admin/verification/queue') {
      return { body: { success: true, data: request.url.searchParams.get('status') === 'PENDING' ? documents : [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
}

afterEach(() => window.history.replaceState({}, '', '/'));

describe('[MC-PR1] Review Center deep link', () => {
  it('opens the named applicant’s file, not the first in the queue', async () => {
    window.history.replaceState({}, '', '/verification?applicant=owner-2');
    mockApi(handler([doc('d1', 'owner-1', 'First'), doc('d2', 'owner-2', 'Second')]));
    renderWithQuery(<VerificationPage />);
    expect(await screen.findByRole('heading', { name: /Second Applicant/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /First Applicant/ })).toBeNull();
  });

  it('says so when nothing of theirs is waiting, instead of passing the queue off as the answer', async () => {
    window.history.replaceState({}, '', '/verification?applicant=owner-9');
    mockApi(handler([doc('d1', 'owner-1', 'First')]));
    renderWithQuery(<VerificationPage />);
    expect((await screen.findByRole('status')).textContent).toMatch(/No documents from this applicant are waiting for review/);
  });
});
