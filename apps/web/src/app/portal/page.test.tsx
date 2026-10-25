import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PortalHome from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { feeDate } from '@/lib/weekly-fee';

afterEach(() => { vi.unstubAllGlobals(); });

describe('portal money presentation', () => {
  it('uses $ for real earnings and an em-dash for absent or unreadable fees', async () => {
    mockApi(({ url }) => {
      const path = url.pathname;
      if (path === '/api/v1/rider/profile') return { body: { data: { id: 'rider-1' } } };
      if (path === '/api/v1/driver/profile') return { status: 404, body: { error: 'No driver profile' } };
      if (path === '/api/v1/rider/earnings/summary') return { body: { data: {
        today: { total: 3500, count: 1 }, thisWeek: { total: 8000, count: 2 },
        thisMonth: { total: 12000, count: 3 }, allTime: { total: 25000, count: 4 },
      } } };
      if (path === '/api/v1/rider/subscription') return { body: { data: { status: 'ACTIVE' } } };
      if (path === '/api/v1/rider/cash-settlements') return { body: { data: {
        summary: { count: 1 }, unsettled: [{ id: 'settle-1', amount: 'unreadable', status: 'PENDING',
          vendor: { name: 'Fixture Store' }, order: { orderNumber: 'SW-1' } }], settled: [],
      } } };
      throw new Error(`Unexpected request: ${path}`);
    });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText('$3,500')).toBeTruthy();
    expect(screen.getByText(/Stores owe you — in delivery fees/)).toBeTruthy();
    expect(screen.getByText(/—\/week/)).toBeTruthy();
    expect(screen.queryByText(/\$NaN|GY\$0\/week|\$0\/week/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U18 / U46 / U47 / U66] The earner office home. The cash ledger
// arrives as { id, orderNumber, amount, status, vendor: { name } } (api
// delivery-cash-settlement.service toWire); the card read r.order.orderNumber,
// so every row said "#undefined". The weekly fee was the list rate and the
// status a raw code. Words are the phone's (EarningsScreen). Synthetic only.
// ---------------------------------------------------------------------------

function riderHome(opts: { subscription?: Record<string, unknown>; ledger?: unknown; onConfirm?: (_request: ApiRequest) => void } = {}) {
  return mockApi((request) => {
    const path = request.url.pathname;
    if (request.method === 'POST' && path.startsWith('/api/v1/rider/cash-settlements/')) {
      opts.onConfirm?.(request);
      return { body: { success: true, data: {} } };
    }
    if (path === '/api/v1/rider/profile') return { body: { data: { id: 'rider-1' } } };
    if (path === '/api/v1/driver/profile') return { status: 404, body: { error: 'No driver profile' } };
    if (path === '/api/v1/rider/earnings/summary') return { body: { data: {
      today: { total: 0, count: 1 }, thisWeek: { total: 0, count: 0 }, thisMonth: { total: 0, count: 0 }, allTime: { total: 0, count: 0 },
    } } };
    if (path === '/api/v1/rider/subscription') return { body: { data: opts.subscription ?? { status: 'ACTIVE', weeklyRate: '2000.00' } } };
    if (path === '/api/v1/rider/cash-settlements') return { body: { data: opts.ledger ?? { unsettled: [], settled: [], summary: { owed: 0, count: 0 } } } };
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  });
}

const owedRow = (over: Record<string, unknown> = {}) => ({
  id: 'settle-1', orderId: 'order-1', orderNumber: 'SW-1001', amount: 500, status: 'PENDING', createdAt: '2026-10-19T10:00:00.000Z',
  vendor: { name: 'Sample Store', logoUrl: null, phone: null }, rider: null, ...over,
});

describe('earner office home: the weekly fee (U18 / U46)', () => {
  it('shows the rate charged, and the status in words', async () => {
    // [FEE-STATUS] As the API sends it (the amount due rides with the row), with the due date passed: the line
    // says since when it is due; it read "next bill <date>" whatever that date was.
    const passed = new Date(Date.now() - 2 * 86_400_000).toISOString();
    riderHome({ subscription: { status: 'PAST_DUE', weeklyRate: '2000.00', customRate: '1500.00', amountDueGyd: 1500, nextBillingDate: passed } });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText('Payment due')).toBeTruthy();
    expect(screen.getByText(new RegExp(`\\$1,500/week · Payment due since ${feeDate(passed)}`))).toBeTruthy();
    expect(screen.queryByText(/next bill/i)).toBeNull();
    expect(screen.queryByText(/\$2,000|PAST_DUE/)).toBeNull();
  });
});

describe('earner office home: what stores owe the rider (U47 / U66)', () => {
  it('names the order and the store from the fields the server sends', async () => {
    riderHome({ ledger: { unsettled: [owedRow()], settled: [], summary: { owed: 500, count: 1 } } });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText(/#SW-1001 · Sample Store/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/undefined/);
    expect(screen.getByRole('button', { name: 'I received the cash' })).toBeTruthy();
  });

  it('asks before it records cash received, names the store and the figure, and sends the ledger\'s own amount', async () => {
    const sent: unknown[] = [];
    riderHome({ ledger: { unsettled: [owedRow()], settled: [], summary: { owed: 500, count: 1 } }, onConfirm: (r) => sent.push(JSON.parse(String(r.init?.body))) });
    const { user } = renderWithQuery(<PortalHome />);
    await user.click(await screen.findByRole('button', { name: 'I received the cash' }));
    expect(sent).toHaveLength(0);
    expect(screen.getByText('Received $500 from Sample Store?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Not yet' }));
    await user.click(screen.getByRole('button', { name: 'I received the cash' }));
    await user.click(screen.getByRole('button', { name: 'Yes, I received $500' }));
    await waitFor(() => expect(sent).toEqual([expect.objectContaining({ amount: '500' })]));
  });

  it('says in words who has confirmed', async () => {
    riderHome({ ledger: { unsettled: [owedRow({ status: 'STORE_CONFIRMED' }), owedRow({ id: 'settle-2', orderNumber: 'SW-1002', status: 'RIDER_CONFIRMED' })], settled: [], summary: { owed: 1000, count: 2 } } });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText('Sample Store says they paid you.')).toBeTruthy();
    expect(screen.getByText('You confirmed — waiting for the store to close it out.')).toBeTruthy();
  });

  it('a row it cannot identify makes the ledger unavailable, never partly shown', async () => {
    riderHome({ ledger: { unsettled: [{ amount: 500, status: 'PENDING' }], settled: [], summary: { owed: 500, count: 1 } } });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText("Couldn't load what stores owe you.")).toBeTruthy();
    expect(screen.queryByText(/Stores owe you/)).toBeNull();
  });
});
