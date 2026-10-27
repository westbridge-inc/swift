import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AuditPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S3-5] "Who did what, and why" — the page said neither.
//
// A row showed "Admin get /api/v1/admin/billing/mmg-checkouts" and "By account
// cmvr…", no reason, the last 50 only, no filter (the API pages and filters).
// It now names the account, says the action in words, quotes the stated
// reason, pages through everything and filters by what, record and day.
// ---------------------------------------------------------------------------

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, userId: 'u-asha', action: 'ADMIN PUT /subscriptions/:id/waive-fee', entity: 'subscriptions', entityId: 'sub_9', ipAddress: null,
  createdAt: '2026-10-27T19:04:00.000Z', actorName: 'Asha Persaud', reason: 'Partner was closed for the flood week, waived once.', ...over,
});

function server(total = 2) {
  return mockApi((r: ApiRequest) => {
    if (r.url.pathname !== '/api/v1/admin/audit-logs') throw new Error(`Unexpected ${r.url}`);
    const page = Number(r.url.searchParams.get('page') ?? 1);
    const data = page === 1 ? [row('a1'), row('a2', { action: 'ADMIN GET /billing/mmg-checkouts', reason: null, actorName: null, userId: 'u-gone' }),
      row('a4', { action: 'ADMIN PUT /api/v1/admin/verification/:id/reject', entity: 'verification' })] : [row('a3', { action: 'APPROVE_STORE_VAT', entity: 'Vendor' })];
    return { body: { success: true, data, meta: { page, limit: 50, total, totalPages: Math.ceil(total / 50), hasNext: page * 50 < total, hasPrev: page > 1 } } };
  });
}
const list = () => screen.getByRole('list', { name: 'Audit log' });

describe('[ADMIN-AUDIT S3-5] the audit log says who, what and why', () => {
  it('names the account, says the route in words and quotes the stated reason', async () => {
    server();
    renderWithQuery(<AuditPage />);
    await screen.findByText('Change: Subscriptions → Waive Fee');
    expect(list().textContent).toContain('By Asha Persaud');
    expect(list().textContent).toContain('“Partner was closed for the flood week, waived once.”');
    expect(list().textContent).toContain('Read: Billing → Mmg Checkouts');
    // the request hook's rows carry the mount point: the words still name the route, not "Api → V1 → Admin"
    expect(list().textContent).toContain('Change: Verification → Reject');
    expect(list().textContent).not.toContain('Api → V1');
    // an id that is no longer an account of this market: said so, the id kept as detail
    expect(list().textContent).toContain('By an account not found here');
    expect(list().textContent).not.toMatch(/Admin put|Admin get/i);
  });

  it('pages through everything the server holds, saying how many', async () => {
    const fetch = server(120);
    const { user } = renderWithQuery(<AuditPage />);
    expect(await screen.findByText(/120 events · page 1 of 3/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/page 2 of 3/);
    expect(fetch.mock.calls.some(([u]) => String(u).includes('page=2'))).toBe(true);
    expect((screen.getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('filters by what, record and day, through the server', async () => {
    const fetch = server();
    const { user } = renderWithQuery(<AuditPage />);
    await screen.findByText('Change: Subscriptions → Waive Fee');
    await user.type(screen.getByLabelText('What happened'), 'waive');
    await user.type(screen.getByLabelText('Record'), 'subscriptions');
    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.type(screen.getByLabelText('To'), '2026-10-27');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => {
      const last = new URL(String(fetch.mock.calls.at(-1)![0]));
      expect(last.searchParams.get('action')).toBe('waive');
      expect(last.searchParams.get('entity')).toBe('subscriptions');
      // Guyana days (UTC-4 all year): from the first moment of the 1st to the last moment of the 27th.
      expect(last.searchParams.get('dateFrom')).toBe('2026-10-01T00:00:00.000-04:00');
      expect(last.searchParams.get('dateTo')).toBe('2026-10-27T23:59:59.999-04:00');
      expect(last.searchParams.get('page')).toBe('1');
    });
    expect(within(list()).getAllByRole('listitem').length).toBeGreaterThan(0);
  });
});
