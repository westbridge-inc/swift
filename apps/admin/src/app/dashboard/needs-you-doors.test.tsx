import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-1 · REVIEW-F #2152 S4-4, S4-5] A row is a door only when the
// account may open the page, and the door opens the tab that lists the row.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ pathname: '/', push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname, useRouter: () => nav, useSearchParams: () => new URLSearchParams(window.location.search) }));

import DashboardPage from './page';
import ClaimsPage from '../claims/page';
import ReturnsPage from '../returns/page';
import SupportPage from '../support/page';

const quiet = {
  todayOrders: 0, todayCompletedOrders: 0, activeVendors: 0, totalVendors: 0, activeRiders: 0, activeDrivers: 0,
  revenue: { weeklySubscriptionRevenue: 0, weeklySubscriptionWaived: 0 }, subscriptionBreakdown: [],
  alerts: { pendingVendors: 0, pastDueSubs: 0, unassignedOrders: 0 },
};
const empty = { body: { success: true, data: [], meta: { page: 1, limit: 50, total: 0, totalPages: 0, hasNext: false, hasPrev: false } } };

afterEach(() => window.history.replaceState({}, '', '/'));

describe('[REVIEW-F #2152 S4-5] a count without a door', () => {
  it('an account that may count documents but not open the Review Center sees the number, not a link to a refusal', async () => {
    mockApi((r: ApiRequest) => {
      if (r.url.pathname === '/api/v1/admin/dashboard/waiting') return { body: { success: true, data: { queues: [
        { key: 'opsAlerts', count: 0, door: true }, { key: 'documents', count: 13, door: false }, { key: 'support', count: 2, door: true },
      ], notCounted: [] } } };
      if (r.url.pathname === '/api/v1/admin/dashboard/overview') return { body: { success: true, data: quiet } };
      return { body: { success: true, data: [] } };
    });
    renderWithQuery(<DashboardPage />);
    const line = await screen.findByText('13 documents waiting for review (both lanes; VAT certificates are under Store VAT). A document reviewer decides these.');
    expect(line.closest('a')).toBeNull();
    const panel = screen.getByRole('heading', { name: 'Needs you' }).parentElement!;
    await waitFor(() => expect(within(panel).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/support?status=OPEN']));
  });
});

describe('[REVIEW-F #2152 S4-4] a door opens the tab that lists its row', () => {
  const pressed = () => screen.getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent?.trim().toLowerCase());
  it('approved claims to pay -> the Approved tab', async () => {
    window.history.replaceState({}, '', '/claims?status=APPROVED');
    const fetch = mockApi(() => empty);
    renderWithQuery(<ClaimsPage />);
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('status=APPROVED'))).toBe(true));
    expect(pressed()).toContain('approved');
  });
  it('refunds owed -> the Refund owed tab', async () => {
    window.history.replaceState({}, '', '/returns?status=REFUND_DUE');
    const fetch = mockApi(() => empty);
    renderWithQuery(<ReturnsPage />);
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('status=REFUND_DUE'))).toBe(true));
  });
  it('tickets being handled -> the In progress tab', async () => {
    window.history.replaceState({}, '', '/support?status=IN_PROGRESS');
    const fetch = mockApi(() => ({ body: { success: true, data: { tickets: [], total: 0, page: 1, limit: 20 } } }));
    renderWithQuery(<SupportPage />);
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('status=IN_PROGRESS'))).toBe(true));
  });
  it('anything that is not a tab of the page is ignored', async () => {
    window.history.replaceState({}, '', '/returns?status=NOT_A_TAB');
    const fetch = mockApi(() => empty);
    renderWithQuery(<ReturnsPage />);
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => String(u).includes('status=REQUESTED'))).toBe(true));
    expect(fetch.mock.calls.some(([u]) => String(u).includes('NOT_A_TAB'))).toBe(false);
  });
});
