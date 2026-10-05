import { screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import FinancePage from './page';
import {
  API_ORIGIN,
  mockApi,
  renderWithQuery,
  requestsByMethod,
  type ApiRequest,
} from '@/test/test-utils';

const settlement = {
  id: 'settlement-1',
  totalBase: 12000,
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-08-08T00:00:00.000Z',
  vendor: { name: 'Test Vendor' },
};

type DailyRow = { date: string; markup: number; delivery_fees: number; total: number; order_count: number };
let dailyRevenue: DailyRow[] = [];

const FULL_SUMMARY = {
  weeklySubscriptionRevenue: 0,
  monthlySubscriptionRevenue: 0,
  activeSubscriptions: 0,
  thirtyDayDeliveryFees: 0,
};
let summary: Record<string, number> = { ...FULL_SUMMARY };

function financeHandler(mutation: (_request: ApiRequest) => { body: unknown; status?: number }) {
  return (request: ApiRequest) => {
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/revenue') {
      return {
        body: {
          success: true,
          data: { dailyRevenue, summary },
        },
      };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/settlements') {
      expect(request.url.search).toBe('?limit=50&status=PENDING');
      return { body: { success: true, data: [settlement] } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/payment-mix') {
      return { body: { success: true, data: { byMethod: [], mmgUnconfirmed: 0 } } };
    }
    if (request.method === 'GET' && request.url.pathname === '/api/v1/admin/finance/cash-settlements') {
      return {
        body: {
          success: true,
          data: [],
          meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
          summary: {},
        },
      };
    }
    return mutation(request);
  };
}

const noMutation = (request: ApiRequest) => {
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
};

// ---------------------------------------------------------------------------
// DASH-06 (render half) — the API sends a GUYANA calendar day as the bare
// label `YYYY-MM-DD`. `new Date('2026-08-23')` parses a date-only string as UTC
// midnight, so `toLocaleDateString()` re-renders it in the BROWSER's zone and
// shifts the bucket a SECOND time: an operator anywhere west of UTC saw every
// day's trading filed under the day before.
//
// The suite therefore runs pinned to a zone west of UTC — in the machine's own
// timezone (or CI's UTC) the bug is invisible and the test would prove nothing.
// ---------------------------------------------------------------------------
const WEST_OF_UTC = 'America/Los_Angeles';
const originalTz = process.env.TZ;

describe('daily revenue renders the GUYANA day, not the browser day [DASH-06]', () => {
  beforeAll(() => { process.env.TZ = WEST_OF_UTC; });
  afterAll(() => { process.env.TZ = originalTz; dailyRevenue = []; summary = { ...FULL_SUMMARY }; });

  it('a Guyana day survives a browser timezone west of UTC', async () => {
    // Guard the premise: if TZ pinning silently stopped working, this suite
    // would pass in UTC for the wrong reason. Under the OLD render the label
    // for 2026-08-23 came out as the 22nd here — that is the defect.
    expect(new Date('2026-08-23').getDate()).toBe(22);

    dailyRevenue = [{ date: '2026-08-23', markup: 0, delivery_fees: 4500, total: 18000, order_count: 6 }];
    mockApi(financeHandler(noMutation));
    renderWithQuery(<FinancePage />);

    // Derived independently of the component: local midnight on the 23rd has
    // the same three calendar fields in every zone.
    const expected = new Date(2026, 7, 23).toLocaleDateString();
    expect(await screen.findByText(expected)).toBeTruthy();

    // And the day it must never be: the 22nd.
    expect(screen.queryByText(new Date(2026, 7, 22).toLocaleDateString())).toBeNull();
  });

  it('a real zero prints $0 — a MISSING amount prints an em-dash, not $0', async () => {
    // A genuine 0 in 30-day delivery fees means "nothing moved". Keep it.
    dailyRevenue = [];
    summary = { ...FULL_SUMMARY, thirtyDayDeliveryFees: 0 };
    mockApi(financeHandler(noMutation));
    const { unmount } = renderWithQuery(<FinancePage />);
    expect(await screen.findByText('$0 GYD')).toBeTruthy();
    unmount();

    // Same screen, field absent: the server told us nothing. Pre-fix
    // `Number(n || 0)` printed "$0" here too — byte-identical to the real zero
    // above while meaning the opposite thing.
    summary = { ...FULL_SUMMARY };
    delete summary['thirtyDayDeliveryFees'];
    mockApi(financeHandler(noMutation));
    renderWithQuery(<FinancePage />);
    expect(await screen.findByText('— GYD')).toBeTruthy();
    expect(screen.queryByText('$0 GYD')).toBeNull();
  });

  it('a malformed day renders an em-dash, never a wrong or invented date', async () => {
    dailyRevenue = [{ date: 'not-a-day', markup: 0, delivery_fees: 100, total: 100, order_count: 1 }];
    mockApi(financeHandler(noMutation));
    renderWithQuery(<FinancePage />);

    // The row still renders its real order count and fees; only the day it
    // cannot vouch for is withheld. A wrong date is a lie; a missing one is
    // only missing.
    expect(await screen.findByText('—')).toBeTruthy();
    expect(screen.getByText('1 orders')).toBeTruthy();
  });
});

describe('finance settlement mutation', () => {
  it('collects a note, confirms, and acknowledges the digest through the exact endpoint and payload — never a payout', async () => {
    const prompt = vi.fn((msg: string) =>
      String(msg) === 'Note for Test Vendor (optional):'
        ? 'BANK-TEST-1'
        : 'Acknowledged against the weekly settlement report');
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('prompt', prompt);
    vi.stubGlobal('confirm', confirm);
    const fetchMock = mockApi(
      financeHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/finance/settlements/settlement-1/process'
        ) {
          return { body: { success: true, data: {} } };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<FinancePage />);
    const paidButton = await screen.findByRole('button', { name: 'Acknowledge' });

    await user.click(paidButton);
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      'Note for Test Vendor (optional):',
    );
    expect(confirm).toHaveBeenNthCalledWith(1, 'Acknowledge this sales digest? Swift moves no money — this records that you reviewed it.');
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(0);

    await user.click(paidButton);
    await waitFor(() => expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1));
    const [url, init] = requestsByMethod(fetchMock, 'PUT')[0]!;
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      'Note for Test Vendor (optional):',
    );
    expect(confirm).toHaveBeenNthCalledWith(2, 'Acknowledge this sales digest? Swift moves no money — this records that you reviewed it.');
    expect(url).toBe(
      `${API_ORIGIN}/api/v1/admin/finance/settlements/settlement-1/process`,
    );
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ reference: 'BANK-TEST-1' });
  });

  it('renders a settlement failure and keeps the pending settlement visible', async () => {
    vi.stubGlobal('prompt', vi.fn((msg: string) =>
      String(msg) === 'Note for Test Vendor (optional):'
        ? 'BANK-TEST-2'
        : 'Acknowledged against the weekly settlement report'));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    const fetchMock = mockApi(
      financeHandler((request) => {
        if (
          request.method === 'PUT' &&
          request.url.pathname === '/api/v1/admin/finance/settlements/settlement-1/process'
        ) {
          return {
            status: 400,
            body: {
              success: false,
              error: { code: 'ALREADY_ACKNOWLEDGED', message: 'This sales digest has already been acknowledged' },
            },
          };
        }
        throw new Error(`Unexpected request: ${request.method} ${request.url}`);
      }),
    );
    const { user } = renderWithQuery(<FinancePage />);
    const paidButton = await screen.findByRole('button', { name: 'Acknowledge' });

    await user.click(paidButton);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Settlement update failed: This sales digest has already been acknowledged',
    );
    expect(screen.getByText('Test Vendor')).toBeTruthy();
    expect((paidButton as HTMLButtonElement).disabled).toBe(false);
    expect(requestsByMethod(fetchMock, 'PUT')).toHaveLength(1);
    const settlementReads = requestsByMethod(fetchMock, 'GET').filter(([url]) =>
      String(url).includes('/api/v1/admin/finance/settlements?'),
    );
    expect(settlementReads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [ADMIN-TRUTH] Each finance read that FAILED fell through to a zero or an
// empty state: "0" active subscriptions, "$0" outstanding with "0 unsettled
// handovers", "0" unconfirmed MMG deliveries, "No completed orders yet",
// "Nothing here", and the pending sales digests silently vanished. On a
// finance page a failed read must say it failed — never an authoritative zero.
// ---------------------------------------------------------------------------

const FAILED = { status: 500, body: { success: false, error: { code: 'INTERNAL', message: 'boom' } } };

/** The summary card whose label is `label`. */
const card = (label: string) => screen.getByText(label).parentElement as HTMLElement;

function failingFinance(failing: ReadonlySet<string>) {
  const ok = financeHandler(noMutation);
  return mockApi((request) => (request.method === 'GET' && failing.has(request.url.pathname) ? FAILED : ok(request)));
}

describe('[ADMIN-TRUTH] a failed finance read is unavailable, never zero', () => {
  it('revenue: the summary cards and the daily list say unavailable', async () => {
    failingFinance(new Set(['/api/v1/admin/finance/revenue']));
    renderWithQuery(<FinancePage />);

    expect(await screen.findByText(/Revenue could not be loaded/)).toBeTruthy();
    expect(screen.getAllByText('unavailable').length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(/No completed orders in the last 30 days/)).toBeNull();
    // Active subscriptions used to print a bare 0.
    const active = within(card('Active Subscriptions'));
    expect(active.getByText('unavailable')).toBeTruthy();
    expect(active.queryByText('0')).toBeNull();
  });

  it('payment mix: no "no orders yet" and no zero unconfirmed count', async () => {
    failingFinance(new Set(['/api/v1/admin/finance/payment-mix']));
    renderWithQuery(<FinancePage />);

    expect(await screen.findByText(/Payment mix could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/No completed orders yet/)).toBeNull();
    const unconfirmed = within(card('MMG deliveries unconfirmed'));
    expect(unconfirmed.getByText('unavailable')).toBeTruthy();
    expect(unconfirmed.queryByText('0')).toBeNull();
  });

  it('cash ledger: no $0 outstanding, no zero handovers, no "nothing here"', async () => {
    failingFinance(new Set(['/api/v1/admin/finance/cash-settlements']));
    renderWithQuery(<FinancePage />);

    expect(await screen.findByText(/cash ledger could not be loaded/i)).toBeTruthy();
    const outstanding = within(card('Store → rider fees outstanding'));
    expect(outstanding.getByText('unavailable')).toBeTruthy();
    expect(outstanding.queryByText('$0')).toBeNull();
    expect(screen.queryByText(/0 unsettled handovers/)).toBeNull();
    expect(screen.queryByText(/Nothing here/)).toBeNull();
  });

  it('sales digests: a failed read is shown, not hidden as "nothing pending"', async () => {
    failingFinance(new Set(['/api/v1/admin/finance/settlements']));
    renderWithQuery(<FinancePage />);

    expect(await screen.findByText(/sales digests could not be loaded/i)).toBeTruthy();
  });

  it('when every read succeeds with real zeros, the zeros are shown as zeros', async () => {
    mockApi(financeHandler(noMutation));
    renderWithQuery(<FinancePage />);

    expect(await screen.findByText('$0 GYD')).toBeTruthy();
    expect(await screen.findByText('0 unsettled handovers (MMG orders)')).toBeTruthy();
    expect(screen.getByText(/No completed orders yet/)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});
