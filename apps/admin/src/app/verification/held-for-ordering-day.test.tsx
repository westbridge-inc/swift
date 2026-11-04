import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [BUG-HUNT F23] Before ordering day the last paper a partner needs cannot be approved: approving it would start their
// free trial. The reviewer has checked it, so the queue marks it and nobody checks it twice, and on ordering day the
// filter finds the batch.
// ---------------------------------------------------------------------------

const doc = (id: string, userId: string, firstName: string, approvalHeldAt: string | null) => ({
  id, userId, status: 'PENDING', docType: 'storefront_photo', role: 'VENDOR_OWNER',
  createdAt: '2026-11-03T12:00:00.000Z', consentAt: '2026-11-03T12:00:00.000Z', privacyNoticeVersion: 'test-v1',
  user: { id: userId, firstName, lastName: 'Applicant', phone: `${firstName}-phone`, countryCode: 'GY' },
  previousDecision: null, approvalHeldAt, approvalHeldBy: approvalHeldAt ? 'reviewer-1' : null,
});

function serve(documents: unknown[], approve?: () => { status: number; body: unknown }) {
  const asked: string[] = [];
  const api = mockApi((request: ApiRequest) => {
    asked.push(`${request.method} ${request.url.pathname}?${request.url.searchParams.get('status') ?? ''}`);
    if (request.url.pathname.endsWith('/queue/counts')) return { body: { data: {} } };
    if (request.url.pathname.includes('/users/')) return { body: { data: {} } };
    if (request.url.pathname.endsWith('/custody')) return { body: { data: { timeline: [] } } };
    if (request.url.pathname.endsWith('/document-url')) return { body: { success: true, data: { url: '/api/v1/verification/render/x?expires=1' } } };
    if (request.url.pathname.startsWith('/api/v1/verification/render/')) return { body: { loaded: true } };
    if (request.url.pathname === '/api/v1/admin/verification/queue') {
      return { body: { success: true, data: request.url.searchParams.get('status') === 'PENDING' ? documents : [] } };
    }
    if (request.url.pathname.endsWith('/approve') && approve) return approve();
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
  return { api, asked };
}

describe('[BUG-HUNT F23] a paper held for ordering day', () => {
  it('the queue row says so; any other row does not', async () => {
    serve([doc('d1', 'owner-1', 'Held', '2026-11-03T15:00:00.000Z'), doc('d2', 'owner-2', 'Plain', null)]);
    renderWithQuery(<VerificationPage />);
    const rows = within(await screen.findByRole('table')).getAllByRole('row').slice(1);
    expect(rows.find((r) => r.textContent?.includes('Held Applicant'))!.textContent).toContain('Held for ordering day');
    expect(rows.find((r) => r.textContent?.includes('Plain Applicant'))!.textContent).not.toContain('Held for ordering day');
  });

  it('the review says it was checked and needs no second check', async () => {
    serve([doc('d1', 'owner-1', 'Held', '2026-11-03T15:00:00.000Z')]);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const note = await screen.findByRole('note', { name: 'Held for ordering day' });
    expect(note.textContent).toMatch(/Checked 3 Nov 2026/);
    expect(note.textContent).toContain('it needs no second check');
    expect(note.textContent).toContain('starts their free trial');
  });

  it('a paper not held shows no such note', async () => {
    serve([doc('d2', 'owner-2', 'Plain', null)]);
    const { user } = renderWithQuery(<VerificationPage />);
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByRole('heading', { level: 2, name: 'Plain Applicant' });
    expect(screen.queryByRole('note', { name: 'Held for ordering day' })).toBeNull();
  });

  it('on ordering day the filter finds the batch', async () => {
    serve([doc('d1', 'owner-1', 'Held', '2026-11-03T15:00:00.000Z'), doc('d2', 'owner-2', 'Plain', null)]);
    const { user } = renderWithQuery(<VerificationPage />);
    await screen.findByRole('table');
    await user.click(screen.getByRole('checkbox', { name: 'Held for ordering day' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Held Applicant');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(screen.getByRole('table')).getAllByRole('row').slice(1)).toHaveLength(2);
  });
});
