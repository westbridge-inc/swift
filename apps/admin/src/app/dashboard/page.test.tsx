import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DashboardPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [A-06] ABSENCE OF DATA IS NOT EVIDENCE OF ABSENCE.
//
// Every panel on this page rendered a reassuring sentence when its query
// FAILED: "All clear — no active alerts", "No recent orders", "No data", and a
// weekly total of $0 with a monthly projection multiplied out of it. A
// timeout, a 403 or a schema change looked exactly like a quiet, healthy
// platform — at the one moment an operator most needs to know they are blind.
//
// These tests fail the reads and assert the page says so.
// ---------------------------------------------------------------------------

const healthy = {
  todayOrders: 12,
  todayCompletedOrders: 9,
  activeVendors: 4,
  totalVendors: 7,
  activeRiders: 3,
  activeDrivers: 2,
  revenue: { weeklySubscriptionRevenue: 45000, weeklySubscriptionWaived: 5000 },
  subscriptionBreakdown: [{ type: 'RESTAURANT', count: 4, weeklyRevenue: 45000, waivedCount: 1, weeklyWaived: 5000 }],
  alerts: { pendingVendors: 0, pastDueSubs: 0, unassignedOrders: 0 },
};

function handler(mode: 'ok' | 'fail') {
  return (request: ApiRequest) => {
    if (mode === 'fail') return { status: 503, body: { success: false, error: { code: 'DB_DOWN', message: 'unavailable' } } };
    if (request.url.pathname.includes('orders')) return { body: { success: true, data: [] } };
    return { body: { success: true, data: healthy } };
  };
}

describe('[A-06] a failed dashboard read is never a quiet platform', () => {
  it('says the page is blind, and says these figures are unknown rather than zero', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/dashboard could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/not zero — they are unknown/i)).toBeTruthy();
    // and no card invents a figure
    await waitFor(() => expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(1));
  });

  it('never renders "All clear" when the alerts read failed', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/NOT an all-clear/i)).toBeTruthy();
    expect(screen.queryByText(/All clear — no active alerts/i)).toBeNull();
  });

  it('never renders "No recent orders" when the feed read failed', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/order feed could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/not an empty queue/i)).toBeTruthy();
    expect(screen.queryByText(/No recent orders/i)).toBeNull();
  });

  it('prints no monthly projection when there is no weekly total to project from', async () => {
    mockApi(handler('fail'));
    renderWithQuery(<DashboardPage />);

    await screen.findByText(/dashboard could not be loaded/i);
    expect(screen.queryByText(/Monthly Projection/i)).toBeNull();
    // the old shape: "$0 GYD" as an authoritative total
    expect(screen.queryByText(/^\$0 GYD$/)).toBeNull();
  });

  it('a genuinely quiet platform still reads as quiet — the guard is not a permanent alarm', async () => {
    mockApi(handler('ok'));
    renderWithQuery(<DashboardPage />);

    expect(await screen.findByText(/All clear — no active alerts/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(await screen.findByText('12')).toBeTruthy(); // today's orders, really 12
    expect(screen.getByText(/Monthly Projection/i)).toBeTruthy();
  });
});


// ---------------------------------------------------------------------------
// [A-07] The figure is GUYANESE, it is what will be BILLED, and a missing one
// is unknown — never zero.
// ---------------------------------------------------------------------------
describe('[A-07] the revenue figure says what it is', () => {
  it('renders GY$, never a bare US dollar sign, and names the figure as billable', async () => {
    mockApi(handler('ok'));
    renderWithQuery(<DashboardPage />);
    // The card and the breakdown both carry it — that they AGREE is the point.
    const shown = await screen.findAllByText('GY$45,000');
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/billable this week/i).length).toBeGreaterThanOrEqual(1);
    // The old card rendered "$45,000" with a "GYD · subscriptions" subtitle.
    expect(screen.queryByText('$45,000')).toBeNull();
  });

  it('shows what has been waived out of the figure, as its own number', async () => {
    mockApi(handler('ok'));
    renderWithQuery(<DashboardPage />);
    expect(await screen.findByText('Waived this period')).toBeTruthy();
    expect(screen.getByText('−GY$5,000')).toBeTruthy();
    expect(screen.getByText(/1 waived/)).toBeTruthy();
  });

  it('a MISSING total is unavailable, not GY$0 — the read succeeded and the field did not come', async () => {
    mockApi((request: ApiRequest) => {
      if (request.url.pathname === '/api/v1/admin/dashboard/overview') {
        return { body: { success: true, data: { ...healthy, revenue: {} } } };
      }
      return handler('ok')(request);
    });
    renderWithQuery(<DashboardPage />);
    await waitFor(() => expect(screen.queryByText('GY$0')).toBeNull());
    expect(screen.queryByText('Monthly Projection')).toBeNull();
  });
});
