import { fireEvent, screen, waitFor } from '@testing-library/react';
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

// ---------------------------------------------------------------------------
// [P36 · board 13d / W3 · owner 9 Oct] The taxi driver's office showed one all-time number; the phone and the board
// show Today / This week / This month / All time (GET /driver/earnings/summary, the shape the rider route sends),
// the "100% yours · cash · 0% commission" line, and the earnings statement (a short-lived signed link, ?link=1).
// ---------------------------------------------------------------------------

const windows = (t: number) => ({
  today: { total: t, count: 1 }, thisWeek: { total: t * 2, count: 2 }, thisMonth: { total: t * 3, count: 3 }, allTime: { total: t * 4, count: 4 }, pendingPayout: 0,
});

function office(roles: { rider: boolean; driver: boolean }, statement: Record<string, unknown> = { path: '/statements/driver/signed-abc' }) {
  return mockApi(({ url }) => {
    const path = url.pathname;
    if (path === '/api/v1/rider/profile') return roles.rider ? { body: { data: { id: 'rider-1' } } } : { status: 404, body: { error: 'No rider profile' } };
    if (path === '/api/v1/driver/profile') return roles.driver ? { body: { data: { id: 'driver-1' } } } : { status: 404, body: { error: 'No driver profile' } };
    if (path === '/api/v1/rider/earnings/summary') return { body: { data: windows(1000) } };
    if (path === '/api/v1/driver/earnings/summary') return { body: { data: windows(1500) } };
    if (path === '/api/v1/rider/subscription' || path === '/api/v1/driver/subscription') return { body: { data: { status: 'ACTIVE', weeklyRate: '8000.00' } } };
    if (path === '/api/v1/rider/cash-settlements') return { body: { data: { unsettled: [], settled: [], summary: { owed: 0, count: 0 } } } };
    if (path === '/api/v1/driver/earnings/statement' || path === '/api/v1/rider/earnings/statement') {
      expect(url.searchParams.get('link')).toBe('1');
      return { body: { data: statement } };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
}

describe('[P36] the taxi driver office matches the phone', () => {
  it('a driver: Today / This week / This month / All time from the driver summary, and the 100% yours line', async () => {
    office({ rider: false, driver: true });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByText('$1,500')).toBeTruthy();
    for (const [label, value] of [['Today', '$1,500'], ['This week', '$3,000'], ['This month', '$4,500'], ['All time', '$6,000']]) {
      expect(screen.getByText(label!).parentElement?.textContent).toContain(value);
    }
    expect(screen.getByText('100% yours · cash · 0% commission')).toBeTruthy();
    expect(screen.queryByText(/Taxi earnings · all time/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Taxi rides' })).toBeNull();
  });

  it('a mover who both delivers and drives: each role named, with its own windows and statement', async () => {
    office({ rider: true, driver: true });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByRole('heading', { name: 'Deliveries' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Taxi rides' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('$1,000')).toBeTruthy());
    expect(screen.getByText('$1,500')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get delivery earnings statement' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get taxi earnings statement' })).toBeTruthy();
  });

  it('Get earnings statement opens the signed link in the tab opened on the click', async () => {
    office({ rider: false, driver: true });
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderWithQuery(<PortalHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get earnings statement' }));
    await waitFor(() => expect(tab.location.href).toMatch(/\/statements\/driver\/signed-abc$/));
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it('a statement link that is not a path on Swift\'s API ("//host") is refused: the tab closes', async () => {
    office({ rider: false, driver: true }, { path: '//elsewhere.example/statement' });
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderWithQuery(<PortalHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get earnings statement' }));
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t open your statement. Try again.');
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('about:blank');
  });

  it('a statement the server cannot mint closes the tab and says so', async () => {
    office({ rider: false, driver: true }, {});
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => tab));
    renderWithQuery(<PortalHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Get earnings statement' }));
    expect((await screen.findByRole('alert')).textContent).toBe('We couldn’t open your statement. Try again.');
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('about:blank');
  });
});

// ---------------------------------------------------------------------------
// [Board 13a "CASH COLLECTED" · owner 25 Oct 22:33Z] The office mirrors the phone's fourth tile: this week's cash the
// mover kept from cash jobs, the server's cashInHand figure (never computed here), worded per role, and left out when
// an older API sends nothing — never a guessed $0.
// ---------------------------------------------------------------------------
function cashOffice(roles: { rider: boolean; driver: boolean }, cash: { rider?: unknown; driver?: unknown }) {
  return mockApi(({ url }) => {
    const path = url.pathname;
    if (path === '/api/v1/rider/profile') return roles.rider ? { body: { data: { id: 'rider-1' } } } : { status: 404, body: { error: 'No rider profile' } };
    if (path === '/api/v1/driver/profile') return roles.driver ? { body: { data: { id: 'driver-1' } } } : { status: 404, body: { error: 'No driver profile' } };
    if (path === '/api/v1/rider/earnings/summary') return { body: { data: { ...windows(1000), ...(cash.rider === undefined ? {} : { cashInHand: cash.rider }) } } };
    if (path === '/api/v1/driver/earnings/summary') return { body: { data: { ...windows(1500), ...(cash.driver === undefined ? {} : { cashInHand: cash.driver }) } } };
    if (path === '/api/v1/rider/subscription' || path === '/api/v1/driver/subscription') return { body: { data: { status: 'ACTIVE', weeklyRate: '8000.00' } } };
    if (path === '/api/v1/rider/cash-settlements') return { body: { data: { unsettled: [], settled: [], summary: { owed: 0, count: 0 } } } };
    throw new Error(`Unexpected request: ${path}`);
  });
}

describe('[board 13a] the office shows CASH COLLECTED like the phone', () => {
  it("a rider: this week's cash kept after paying stores, from the server's figure", async () => {
    cashOffice({ rider: true, driver: false }, { rider: { today: 700, thisWeek: 2300, thisMonth: 2400, allTime: 2800 } });
    renderWithQuery(<PortalHome />);
    const label = await screen.findByText('Cash collected');
    expect(label.parentElement?.textContent).toContain('$2,300');
    expect(label.parentElement?.textContent).toContain('This week, after paying stores for the goods');
  });

  it("a driver: this week's cash fares", async () => {
    cashOffice({ rider: false, driver: true }, { driver: { today: 0, thisWeek: 0, thisMonth: 0, allTime: 0 } });
    renderWithQuery(<PortalHome />);
    const label = await screen.findByText('Cash collected');
    expect(label.parentElement?.textContent).toContain('$0');
    expect(label.parentElement?.textContent).toContain('This week: the fares passengers paid you in cash');
  });

  it('an older API that sends no figure (or junk) shows no tile, never $0', async () => {
    cashOffice({ rider: true, driver: true }, { driver: { thisWeek: 'n/a' } });
    renderWithQuery(<PortalHome />);
    expect(await screen.findByRole('heading', { name: 'Taxi rides' })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('$1,500')).toBeTruthy());
    expect(screen.queryByText('Cash collected')).toBeNull();
  });
});
