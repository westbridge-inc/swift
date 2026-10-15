import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [MC-AD1] A RE-SUBMISSION IS SHOWN AS ONE.
//
// A rejected document that the applicant uploads again arrives as a new
// waiting row. The queue now carries the earlier verdict on each row
// (`previousDecision`, GET /admin/verification/queue): the console must say
// "Re-submitted after rejection" with the reason the applicant was asked to
// fix — or "Renewal" — instead of showing it like a first upload. A row
// without it (null: a first upload, or the lookup was unavailable) shows no
// marker and is never treated as an error.
// ---------------------------------------------------------------------------

const doc = (id: string, userId: string, firstName: string, previousDecision: unknown) => ({
  id, userId, status: 'PENDING', docType: 'national_id', role: 'VENDOR_OWNER',
  createdAt: '2026-10-06T12:00:00.000Z', consentAt: '2026-10-06T12:00:00.000Z', privacyNoticeVersion: 'test-v1',
  user: { id: userId, firstName, lastName: 'Applicant', phone: `${firstName}-phone`, countryCode: 'GY' },
  previousDecision,
});

const rejectedBefore = {
  documentId: 'old-1', kind: 'RESUBMITTED_AFTER_REJECTION', status: 'REJECTED',
  reviewNote: 'The photo is too blurry to read the ID number.', decidedAt: '2026-10-05T15:00:00.000Z', submittedAt: '2026-10-05T10:00:00.000Z',
};
const renewal = {
  documentId: 'old-2', kind: 'RENEWAL', status: 'EXPIRED', reviewNote: null, decidedAt: '2025-10-01T15:00:00.000Z', submittedAt: '2025-10-01T10:00:00.000Z',
};

function serve(documents: unknown[]) {
  return mockApi((request: ApiRequest) => {
    if (request.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
    if (request.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (request.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (request.url.pathname.endsWith('/document-url')) return { body: { success: true, data: { url: '/api/v1/verification/render/x?expires=1&sig=s' } } };
    if (request.url.pathname.startsWith('/api/v1/verification/render/')) return { body: { loaded: true } };
    if (request.url.pathname === '/api/v1/admin/verification/queue') {
      return { body: { success: true, data: request.url.searchParams.get('status') === 'PENDING' ? documents : [] } };
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
}

describe('[MC-AD1] the Review Center marks a re-submission', () => {
  it('the queue row says which applicant re-submitted after a rejection, and which is a renewal', async () => {
    serve([doc('d1', 'owner-1', 'First', rejectedBefore), doc('d2', 'owner-2', 'Second', renewal), doc('d3', 'owner-3', 'Third', null)]);
    renderWithQuery(<VerificationPage />);
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    const rowOf = (name: string) => rows.find((r) => r.textContent?.includes(name))!;
    expect(rowOf('First Applicant').textContent).toContain('Re-submitted after rejection: The photo is too blurry to read the ID number.');
    expect(rowOf('Second Applicant').textContent).toContain('Renewal');
    expect(rowOf('Third Applicant').textContent).not.toMatch(/Re-submitted|Renewal/);
  });

  it('the review shows the earlier verdict and the reason the applicant was asked to fix', async () => {
    serve([doc('d1', 'owner-1', 'First', rejectedBefore)]);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const note = await screen.findByRole('note', { name: 'Earlier decision' });
    expect(note.textContent).toContain('Re-submitted after rejection');
    expect(note.textContent).toContain('Last time: The photo is too blurry to read the ID number.');
    expect(note.textContent).toMatch(/Rejected 5 Oct 2026/);
  });

  it('a renewal says what it renews; a first upload shows no earlier-decision panel at all', async () => {
    serve([doc('d2', 'owner-2', 'Second', renewal)]);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const note = await screen.findByRole('note', { name: 'Earlier decision' });
    expect(note.textContent).toContain('Renewal');
    expect(note.textContent).toMatch(/replaces a document that expired/);
  });

  it('a row with no earlier decision (first upload, or the lookup unavailable) has no marker and no error', async () => {
    serve([doc('d3', 'owner-3', 'Third', null)]);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByRole('heading', { name: /Third Applicant/ });
    expect(screen.queryByRole('note', { name: 'Earlier decision' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
