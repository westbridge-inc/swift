import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DashboardPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [ADMIN-AUDIT S2-1] TODAY: EVERYTHING WAITING FOR YOU, IN ONE PLACE.
//
// "Needs you" counted unassigned orders, past-due fees and pending stores, and
// said "All clear — no active alerts" while an ops page waited to be
// acknowledged, 13 documents waited for review, a second signature was owed
// and a SAFETY ticket was open. It now lists every queue the server counts
// (GET /admin/dashboard/waiting), SOS pages and safety first, each a door to
// its page; a count the server could not read, a failed read, or a queue this
// account cannot open is never shown as all clear.
// ---------------------------------------------------------------------------

const quiet = {
  todayOrders: 0, todayCompletedOrders: 0, activeVendors: 0, totalVendors: 0, activeRiders: 0, activeDrivers: 0,
  revenue: { weeklySubscriptionRevenue: 0, weeklySubscriptionWaived: 0 }, subscriptionBreakdown: [],
  alerts: { pendingVendors: 0, pastDueSubs: 0, unassignedOrders: 0 },
};
const KEYS = ['opsAlerts', 'supportSafety', 'supportSafetyInProgress', 'documents', 'approvals', 'paymentConfirmations', 'support',
  'supportInProgress', 'catalogue', 'storeVat', 'custody', 'claimsToDecide', 'claimsToPay', 'claimsAutoToPay', 'returnsToDecide',
  'refundsOwed', 'moderation'] as const;
const counts = (over: Partial<Record<(typeof KEYS)[number], number | null>> = {}, notCounted: string[] = []) => ({
  queues: KEYS.filter((k) => !notCounted.includes(k)).map((key) => ({ key, count: key in over ? over[key]! : 0 })),
  notCounted,
});

function page(waiting: { status?: number; body: unknown }, overview: unknown = quiet) {
  mockApi((r: ApiRequest) => {
    if (r.url.pathname === '/api/v1/admin/dashboard/waiting') return waiting;
    if (r.url.pathname === '/api/v1/admin/dashboard/overview') return { body: { success: true, data: overview } };
    if (r.url.pathname.includes('orders')) return { body: { success: true, data: [] } };
    throw new Error(`Unexpected ${r.method} ${r.url.pathname}`);
  });
  renderWithQuery(<DashboardPage />);
}
const panel = () => screen.getByRole('heading', { name: 'Needs you' }).parentElement!;
const doors = () => within(panel()).queryAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);

describe('[ADMIN-AUDIT S2-1] Today lists every queue that waits for a person', () => {
  it('the audit\'s world: an ops page, 13 documents, an approval and a SAFETY ticket are listed — SOS and safety first — and it is not "All clear"', async () => {
    page({ body: { success: true, data: counts({ opsAlerts: 1, documents: 13, approvals: 1, supportSafety: 1 }) } });
    await waitFor(() => expect(doors()).toHaveLength(4));
    expect(doors()).toEqual([
      ['1 SOS or ops page waiting to be acknowledged', '/ops-alerts'],
      ['1 safety ticket open', '/support?status=OPEN'],
      ['13 documents waiting for review', '/verification'],
      ['1 request waiting for a second admin', '/approvals'],
    ]);
    expect(screen.queryByText(/All clear/)).toBeNull();
  });

  it('every queue has its own door, with the page it opens', async () => {
    page({ body: { success: true, data: counts(Object.fromEntries(KEYS.map((k) => [k, 2]))) } });
    await waitFor(() => expect(doors()).toHaveLength(KEYS.length));
    // Each door opens the tab that lists its row [REVIEW-F #2152 S4-4].
    expect(doors().map(([, href]) => href)).toEqual(['/ops-alerts', '/support?status=OPEN', '/support?status=IN_PROGRESS', '/verification',
      '/approvals', '/payment-confirmations', '/support?status=OPEN', '/support?status=IN_PROGRESS', '/catalogue-check', '/store-vat',
      '/custody', '/claims', '/claims?status=APPROVED', '/claims?status=AUTO_APPROVED', '/returns', '/returns?status=REFUND_DUE', '/moderation']);
    expect(doors()[0]![0]).toBe('2 SOS or ops pages waiting to be acknowledged');
  });

  it('the overview\'s own alerts stay, after SOS and safety', async () => {
    page({ body: { success: true, data: counts({ supportSafety: 1, documents: 2 }) } }, { ...quiet, alerts: { pendingVendors: 3, pastDueSubs: 0, unassignedOrders: 2 } });
    await waitFor(() => expect(doors()).toHaveLength(4));
    expect(doors().map(([text]) => text)).toEqual(['1 safety ticket open', '2 orders unassigned for > 10 minutes', '2 documents waiting for review', '3 vendors pending approval']);
  });

  it('a queue the server could not count is said to be unknown, never zero, and is not "All clear"', async () => {
    page({ body: { success: true, data: counts({ documents: null }) } });
    expect(await screen.findByText('Could not count documents waiting for review. This is not zero.')).toBeTruthy();
    expect(screen.queryByText(/All clear/)).toBeNull();
  });

  it('a failed count read is NOT an all-clear, even with the figures on screen', async () => {
    page({ status: 503, body: { success: false, error: { code: 'DB_DOWN', message: 'unavailable' } } });
    expect(await screen.findByText(/SOS pages, documents and other queues could not be counted/)).toBeTruthy();
    expect(screen.queryByText(/All clear/)).toBeNull();
  });

  it('an answer without counts is not a count', async () => {
    page({ body: { success: true, data: {} } });
    expect(await screen.findByText(/could not be counted/)).toBeTruthy();
    expect(screen.queryByText(/All clear/)).toBeNull();
  });

  it('queues this account cannot open are named as not counted — never a plain "All clear"', async () => {
    page({ body: { success: true, data: counts({}, ['approvals', 'custody', 'claimsToPay']) } });
    expect(await screen.findByText('All clear in the queues you can open.')).toBeTruthy();
    expect(screen.getByText(/3 other queues need a permission your account does not have/)).toBeTruthy();
    expect(screen.queryByText(/All clear — no active alerts/)).toBeNull();
  });

  it('a quiet platform, every queue counted at zero, still reads as quiet', async () => {
    page({ body: { success: true, data: counts() } });
    expect(await screen.findByText('All clear — no active alerts.')).toBeTruthy();
    expect(doors()).toEqual([]);
  });
});
