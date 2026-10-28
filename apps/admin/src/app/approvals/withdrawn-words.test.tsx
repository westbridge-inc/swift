import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApprovalsPage from './page';
import { decidedBy, type ApprovalRow } from '@/lib/approvals';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-7 · REVIEW-G #2156 S3-1, lifted from G's probe] A request its asker WITHDREW (the server sets
// CANCELLED and the decision time, never an approver) read "cancelled by an account not found here": words that
// blame an unknown account on the who-did-what surface. The one who withdrew it is the asker, so the card names them;
// a decision with no decider recorded names nobody rather than inventing one.
// ---------------------------------------------------------------------------

const base = {
  action: 'PUT /subscriptions/:id/waive-fee', cls: 'C4', capability: 'subscription.waive', entityId: 'sub_9', fingerprint: 'a'.repeat(64),
  reason: 'Partner was closed for the flood week; waive it.', bodySnapshot: { params: { id: 'sub_9' }, body: {} }, appliedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date(Date.now() - 600_000).toISOString(), isOwnRequest: false,
};
const WITHDRAWN = { ...base, id: 'ap-w', status: 'CANCELLED', requestedBy: 'cm-asker-id', requestedByName: 'Asha Persaud', approvedBy: null, approvedByName: null, decisionNote: 'Withdrawn by the admin who asked for it', decidedAt: new Date().toISOString() };

describe('[ADMIN-AUDIT S3-7] a withdrawn request names the one who withdrew it', () => {
  it('the card says the asker cancelled it, never an unknown account', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/approvals') return { body: { success: true, data: r.url.searchParams.get('status') === 'CANCELLED' ? [WITHDRAWN] : [] } };
      return { body: { success: true, data: [] } };
    });
    const { user } = renderWithQuery(<ApprovalsPage />);
    await user.click(await screen.findByRole('button', { name: /^Cancelled/ }));
    await screen.findByText(/asked by Asha Persaud/);
    expect(screen.getByText(/cancelled by Asha Persaud/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/account not found here/);
    expect(document.body.textContent).not.toMatch(/cm-asker-id/);
  });

  it('who decided: the asker for a withdrawal, the approver otherwise, nobody when none is recorded', () => {
    const row = (over: Partial<ApprovalRow>) => ({ ...WITHDRAWN, ...over }) as unknown as ApprovalRow;
    expect(decidedBy(row({}))).toBe('Asha Persaud');
    expect(decidedBy(row({ status: 'REJECTED', approvedBy: 'cm-omar-id', approvedByName: 'Omar Khan' }))).toBe('Omar Khan');
    expect(decidedBy(row({ status: 'APPROVED', approvedBy: 'cm-gone-id', approvedByName: null }))).toBe('an account not found here');
    expect(decidedBy(row({ status: 'REJECTED', approvedBy: null, approvedByName: null }))).toBeNull();
  });
});
