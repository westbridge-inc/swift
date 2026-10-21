import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';

vi.mock('@/components/customer-session', () => ({
  useCustomerSession: () => ({ scope: 'fixture-customer', epoch: 0 }),
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

afterEach(() => { vi.unstubAllGlobals(); router.push.mockReset(); });

/** The two reads the page makes, as the server answers them: `?live=true` and `?live=false&page=N`. */
function ordersApi({ live = [], liveTotal, pages = [[]], onPost }: {
  live?: unknown[]; liveTotal?: number; pages?: unknown[][]; onPost?: (_request: ApiRequest) => { status?: number; body: unknown };
}) {
  const total = pages.reduce((n, p) => n + p.length, 0);
  return mockApi((request) => {
    const { url, method } = request;
    if (method === 'POST' && onPost) return onPost(request);
    if (url.pathname !== '/api/v1/customer/orders') throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    if (url.searchParams.get('live') === 'true') {
      return { body: { data: live, meta: { page: 1, totalPages: 1, total: liveTotal ?? live.length } } };
    }
    if (url.searchParams.get('live') !== 'false') throw new Error(`History must be asked for as such: ${url.search}`);
    const page = Number(url.searchParams.get('page') ?? '1');
    return { body: { data: pages[page - 1] ?? [], meta: { page, totalPages: pages.length, total } } };
  });
}

const done = (n: number, over: Record<string, unknown> = {}) => ({
  id: `order-${n}`, orderNumber: `SW-${1000 + n}`, status: 'DELIVERED', orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
  vendorName: `Fixture Kitchen ${n}`, totalAmount: 2500, placedAt: '2026-10-01T15:00:00.000Z', items: [{ id: `line-${n}`, name: 'Sample bowl' }], ...over,
});

describe('customer order total presentation', () => {
  it('does not invent a zero for a missing total', async () => {
    ordersApi({ pages: [[{ id: 'order-1', orderNumber: 'SW-1001', status: 'DELIVERED', vendorName: 'Fixture Market', items: [{ id: 'line-1' }] }]] });
    renderWithQuery(<OrdersPage />);
    const row = await screen.findByText('Fixture Market');
    expect(row.closest('a')?.textContent).toContain('—');
    expect(row.closest('a')?.textContent).not.toContain('GY$0');
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U13] The list read only the newest 20 orders and split them by
// status here: an older order still in progress was missing from "In
// progress", and older history could not be reached. As on the phone, live
// orders are asked for as such, and history is paged with Show more.
// ---------------------------------------------------------------------------
describe('[U13] every live order, and all of history', () => {
  it('an order in progress older than the newest page is still under In progress', async () => {
    const old = { ...done(99), id: 'order-old', orderNumber: 'SW-0042', status: 'READY_FOR_PICKUP', vendorName: 'Fixture Old Kitchen', placedAt: '2026-03-01T15:00:00.000Z' };
    ordersApi({ live: [old], pages: [Array.from({ length: 20 }, (_, i) => done(i + 1))] });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByRole('link', { name: 'Track Fixture Old Kitchen SW-0042' })).toBeTruthy();
  });

  it('history pages with Show more, and says how much of it is shown', async () => {
    const fetchMock = ordersApi({ pages: [Array.from({ length: 20 }, (_, i) => done(i + 1)), [done(21), done(22)]] });
    const { user } = renderWithQuery(<OrdersPage />);
    await screen.findByText('Fixture Kitchen 20');
    expect(screen.queryByText('Fixture Kitchen 21')).toBeNull();
    const more = screen.getByRole('button', { name: 'Show more. 20 of 22 shown' });
    expect(more.textContent).toContain('20 of 22 shown');
    await user.click(more);
    expect(await screen.findByText('Fixture Kitchen 22')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('live=false&page=2'))).toBe(true);
  });

  it('a failed next page says so and retries, never silently resetting to Show more', async () => {
    let failSecond = true;
    mockApi(({ url }) => {
      if (url.searchParams.get('live') === 'true') return { body: { data: [], meta: { total: 0 } } };
      const page = Number(url.searchParams.get('page'));
      if (page === 2 && failSecond) { failSecond = false; return { status: 503, body: { error: { message: 'Unavailable' } } }; }
      return { body: { data: page === 1 ? Array.from({ length: 20 }, (_, i) => done(i + 1)) : [done(21)], meta: { page, totalPages: 2, total: 21 } } };
    });
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await screen.findByRole('button', { name: /Show more/ }));
    expect(await screen.findByText("Couldn't load more orders.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Fixture Kitchen 21')).toBeTruthy();
  });

  it('more live orders than one page says so instead of quietly showing a prefix', async () => {
    ordersApi({ live: [{ ...done(1), status: 'PREPARING' }], liveTotal: 53 });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('+52 more in progress')).toBeTruthy();
  });

  it('an order both reads returned is shown once, as live', async () => {
    const both = { ...done(7), status: 'EN_ROUTE_DELIVERY' };
    ordersApi({ live: [both], pages: [[both, done(8)]] });
    renderWithQuery(<OrdersPage />);
    await screen.findByText('Fixture Kitchen 8');
    expect(screen.getAllByText(/Fixture Kitchen 7/)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U14] Statuses as codes or in words the phone does not use. The
// phone's orderStatusLabel speaks by the order's own vertical.
// ---------------------------------------------------------------------------
describe('[U14] statuses in the phone\'s words', () => {
  it.each([
    [{ status: 'RIDER_EN_ROUTE_PICKUP', orderType: 'FOOD_DELIVERY' }, 'Rider on the way to the store'],
    [{ status: 'PENDING', orderType: 'GROCERY_DELIVERY' }, 'Waiting for the store'],
    [{ status: 'RIDER_EN_ROUTE_PICKUP', orderType: 'COURIER' }, 'Rider on the way to collect'],
    [{ status: 'DRIVER_EN_ROUTE', orderType: 'TAXI' }, 'Driver on the way'],
  ])('a live %o reads "%s"', async (over, words) => {
    ordersApi({ live: [{ ...done(1), ...over }] });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText(new RegExp(` · ${words}$`))).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[A-Z]{3,}_[A-Z]|en route pickup/);
  });

  it('a finished order reads in words in history', async () => {
    ordersApi({ pages: [[done(1, { status: 'RETURNED', orderType: 'COURIER' })]] });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('Returned to sender')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// [UI-SWEEP U17] The home tile says "Track and reorder"; the website had no
// Reorder anywhere. As on the phone: put the lines back, then the cart, and
// name the lines left out before the cart opens.
// ---------------------------------------------------------------------------
describe('[U17] reorder a finished store order', () => {
  it('puts the order back in the cart and opens the cart', async () => {
    const posts: string[] = [];
    ordersApi({ pages: [[done(1)]], onPost: ({ url }) => { posts.push(url.pathname); return { body: { success: true, data: { addedItems: 1, unavailableItems: 0 } } }; } });
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await screen.findByRole('button', { name: 'Reorder Fixture Kitchen 1 SW-1001' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/cart'));
    expect(posts).toEqual(['/api/v1/customer/orders/order-1/reorder']);
  });

  it('names the lines left out and lets the customer open the cart', async () => {
    ordersApi({ pages: [[done(1)]], onPost: () => ({ body: { success: true, data: { unavailableItems: 1, message: 'Sample bowl is sold out.' } } }) });
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await screen.findByRole('button', { name: /^Reorder/ }));
    const notice = await screen.findByRole('status');
    expect(within(notice).getByText('Some items were not added')).toBeTruthy();
    expect(within(notice).getByText('Sample bowl is sold out.')).toBeTruthy();
    expect(within(notice).getByRole('link', { name: 'Go to your cart' }).getAttribute('href')).toBe('/cart');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('a failed reorder says so beside the button', async () => {
    ordersApi({ pages: [[done(1)]], onPost: () => ({ status: 400, body: { success: false, error: { code: 'VENDOR_UNAVAILABLE', message: 'This restaurant is no longer available' } } }) });
    const { user } = renderWithQuery(<OrdersPage />);
    await user.click(await screen.findByRole('button', { name: /^Reorder/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('a ride, a parcel, a booking or a cancelled order offers no Reorder', async () => {
    ordersApi({ pages: [[
      done(1, { orderType: 'TAXI' }),
      done(2, { orderType: 'COURIER' }),
      done(3, { fulfillment: 'APPOINTMENT' }),
      done(4, { status: 'CANCELLED' }),
    ]] });
    renderWithQuery(<OrdersPage />);
    await screen.findByText('Fixture Kitchen 4');
    expect(screen.queryByRole('button', { name: /^Reorder/ })).toBeNull();
  });
});
