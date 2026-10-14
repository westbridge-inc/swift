import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VerificationPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [GUARDRAILS §8 · Opus S3-9] The catalogue check's Approve button needs the catalogue-approver grant; the
// super-admin gives it to themselves in the Review Center, beside the document reviewer grant (owner, 14 Oct).
describe('[§8 · S3-9] the Review Center carries the catalogue approver grant', () => {
  it('shows the catalogue approvers panel beside the document reviewers panel', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/staff/document-reviewers') {
        return { body: { success: true, data: [{ userId: 'usr_me', name: 'Synthetic Owner', role: 'SUPER_ADMIN', active: true, documentReviewer: true, catalogueApprover: false, you: true }] } };
      }
      if (r.url.pathname.endsWith('/queue/counts')) return { body: { data: { byLane: { PENDING: { operator: 0, customer: 0 } } } } };
      if (r.url.pathname.endsWith('/queue')) return { body: { data: [], meta: { hasNext: false, total: 0 } } };
      throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
    });
    renderWithQuery(<VerificationPage />);
    expect(await screen.findByRole('region', { name: 'Document reviewers' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Catalogue approvers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Grant myself the catalogue-approver permission' })).toBeTruthy();
  });
});
