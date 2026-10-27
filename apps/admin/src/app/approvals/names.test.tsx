import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApprovalsPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-7] The approval card named the asker by account id. It names
// the asker and the approver (the server reads the names, inside this market).
// ---------------------------------------------------------------------------

const base = {
  action: 'PUT /subscriptions/:id/waive-fee', cls: 'C4', capability: 'subscription.waive', entityId: 'sub_9', fingerprint: 'a'.repeat(64),
  reason: 'Partner was closed for the flood week; waive it.', bodySnapshot: { params: { id: 'sub_9' }, body: {} }, decisionNote: null, appliedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: new Date(Date.now() - 600_000).toISOString(), isOwnRequest: false,
};
const APPROVED = { ...base, id: 'ap-a', status: 'APPROVED', requestedBy: 'cm-asker-id', requestedByName: 'Asha Persaud', approvedBy: 'cm-omar-id', approvedByName: 'Omar Khan', decidedAt: new Date().toISOString() };
const STRANGER = { ...base, id: 'ap-s', status: 'APPROVED', requestedBy: 'cm-asker-id', requestedByName: 'Asha Persaud', approvedBy: 'cm-gone-id', approvedByName: null, decidedAt: new Date().toISOString() };

describe('[ADMIN-AUDIT S3-7] an approval names who asked and who decided', () => {
  it('by name, never by account id; an account not found here is said so', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/approvals') return { body: { success: true, data: r.url.searchParams.get('status') === 'APPROVED' ? [APPROVED, STRANGER] : [] } };
      return { body: { success: true, data: [] } };
    });
    const { user } = renderWithQuery(<ApprovalsPage />);
    await user.click(await screen.findByRole('button', { name: /^Approved/ }));
    expect((await screen.findAllByText(/asked by Asha Persaud/)).length).toBe(2);
    expect(screen.getByText(/by Omar Khan/)).toBeTruthy();
    expect(screen.getByText(/by an account not found here/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/cm-asker-id|cm-omar-id/);
  });
});
