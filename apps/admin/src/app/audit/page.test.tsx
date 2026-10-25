import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AuditPage from './page';
import { mockApi, renderWithQuery } from '@/test/test-utils';

// [ADMIN-UI · REVIEW-F #2056 S3-1] The audit log lists EVERY account's recorded
// actions — a customer's "I paid" claim and a partner's fee claim sit beside
// admins' approvals. A row names its actor neutrally ("By account …"), never as
// an admin, and says what happened in words while keeping the code in reach.
const rows = [
  { id: 'a1', userId: 'cust-1', action: 'CUSTOMER_CLAIMED_PAID', entity: 'Order', entityId: 'ord-1', ipAddress: null, createdAt: '2026-10-20T10:00:00.000Z' },
  { id: 'a2', userId: null, action: 'CONFIG_UPDATED', entity: 'PlatformConfig', entityId: 'order_auto_reject_minutes', ipAddress: null, createdAt: '2026-10-20T10:00:00.000Z' },
];

describe('[ADMIN-UI] audit log rows', () => {
  it('names the actor as an account, never as an admin, and the action in words', async () => {
    mockApi((r) => {
      if (r.url.pathname === '/api/v1/admin/audit-logs') return { body: { success: true, data: rows } };
      throw new Error(`Unexpected request: ${r.method} ${r.url}`);
    });
    renderWithQuery(<AuditPage />);
    const claim = await screen.findByText('Customer claimed paid');
    expect(claim.getAttribute('title')).toBe('CUSTOMER_CLAIMED_PAID');
    const list = screen.getByRole('list', { name: 'Audit log' });
    expect(list.textContent).toContain('By account cust-1');
    expect(list.textContent).not.toMatch(/By admin/);
    expect(list.textContent).toContain('Platform config');
    expect(list.textContent).not.toContain('CONFIG_UPDATED');
  });
});
