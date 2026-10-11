import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OrdersPage from './page';
import { mockApi, renderWithQuery, stubAudioContext, type ApiRequest } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';
import { guyanaDayKey } from '@/lib/vendor-hub';

// ---------------------------------------------------------------------------
// PR A (owner ruling, 11 Oct 2026): the website's Orders home copies the phone
// app's business board (apps/mobile/src/modules/vendor/screens/VendorOps.tsx):
// the revenue pulse, the first-order guide, the Manage tiles, store open and
// pause, "Deliver my own orders", actions on the order cards — the old Today
// page merged in. Every read and write is an endpoint the app already uses.
// ---------------------------------------------------------------------------

type Role = 'OWNER' | 'MANAGER' | 'STAFF';
interface Opts {
  role?: Role; lifetime?: number; open?: boolean; accepting?: boolean; selfDelivery?: boolean;
  orders?: unknown[]; storeRoles?: Record<string, Role>; status?: string; holdProfileRefetch?: Promise<{ body: unknown }>; failProfileRefetch?: boolean;
}

const writes: Array<{ method: string; path: string; body: unknown }> = [];
const reads: string[] = [];

function hubApi(opts: Opts = {}) {
  const { role = 'OWNER', lifetime = 40, open = true, accepting = true, selfDelivery = false, orders = [], storeRoles, status = 'ACTIVE' } = opts;
  const profileHold = opts.holdProfileRefetch;
  let profileReads = 0;
  const daily = Array.from({ length: 13 }, (_, i) => {
    const offset = i - 13; // -13 … -1: the series ends yesterday, as the server's does
    return { date: guyanaDayKey(offset), revenue: offset === -7 ? 10000 : 2000, orders: 1 };
  });
  return mockApi((request: ApiRequest) => {
    const { method, url, init } = request;
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') { writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null }); return { body: { success: true, data: {} } }; }
    reads.push(path);
    const store = (init?.headers as Record<string, string> | undefined)?.['x-vendor-id'] ?? 'store-1';
    if (path === '/vendor/stores') {
      return { body: { success: true, data: {
        stores: [
          { id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', isCurrentlyOpen: open, acceptingOrders: accepting, city: null, isVerified: true },
          { id: 'store-2', name: 'Sample Shop', vendorType: 'STORE', isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true },
        ],
        selectedId: store, myRole: storeRoles?.[store] ?? role,
      } } };
    }
    if (path === '/vendor/profile') {
      // The server's real shape (vendor.routes.ts GET /profile; staff-roles.test.ts):
      // { id, userId, vendors: [...], myRole }. The selected store is NOT first here,
      // so a page that took vendors[0] would show the wrong store.
      if (profileHold && profileReads > 0) { profileReads += 1; return profileHold; }
      if (opts.failProfileRefetch && profileReads > 0) { profileReads += 1; return { status: 503, body: { success: false, error: { message: 'Service unavailable' } } }; }
      profileReads += 1;
      return { body: { success: true, data: {
        id: 'owner-1', userId: 'user-1', myRole: storeRoles?.[store] ?? role,
        vendors: [
          { id: 'store-2', name: 'Sample Shop', vendorType: 'STORE', status: 'ACTIVE', isVerified: true, isCurrentlyOpen: false, acceptingOrders: false, selfDeliveryEnabled: false, operatingHours: [], _count: { orders: 9, items: 1 } },
          {
            id: 'store-1', name: 'Sample Kitchen', vendorType: 'RESTAURANT', status, isVerified: true,
            isCurrentlyOpen: open, acceptingOrders: accepting, selfDeliveryEnabled: selfDelivery,
            operatingHours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: '08:00', closeTime: '22:00', isClosed: false })),
            _count: { orders: lifetime, items: 3 },
          },
        ],
      } } };
    }
    if (path === '/vendor/analytics/overview') {
      if (role === 'STAFF') return { status: 403, body: { success: false, error: { message: 'Managers only' } } };
      return { body: { success: true, data: { vendor: { averageRating: 4.8, totalRatings: 12, totalOrders: lifetime, isCurrentlyOpen: open, acceptingOrders: accepting }, today: { orders: 6, revenue: 15000 }, week: { orders: 31, revenue: 77500 }, month: { orders: 118, revenue: 295000 }, activeMenuItems: 2, pendingOrders: 0, queueValue: 0 } } };
    }
    if (path === '/vendor/analytics/revenue') return { body: { success: true, data: { daily, totals: { orders: 13 } } } };
    if (path === '/vendor/analytics/ops') return { body: { success: true, data: { avgAcceptMinutes: 4 } } };
    if (path === '/vendor/items') return { body: { success: true, data: [
      { id: 'i1', name: 'Pepperpot bowl', basePrice: '1500.00', isAvailable: true, imageUrl: 'https://img.test/1.jpg' },
      { id: 'i2', name: 'Cook-up rice', basePrice: '1500.00', isAvailable: true, imageUrl: null },
      { id: 'i3', name: 'Sorrel', basePrice: '500.00', isAvailable: false, imageUrl: null },
    ] } };
    if (path === '/vendor/hours') return { body: { success: true, data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: '08:00', closeTime: '22:00', isClosed: false })) } };
    if (path === '/vendor/qr') return { body: { success: true, data: { shortUrl: 'https://swift.test/s/SAMPLE', status: 'ACTIVE' } } };
    if (path === '/vendor/subscription') return { body: { success: true, data: { status: 'ACTIVE', nextBillingDate: '2026-10-18T12:00:00Z' } } };
    if (path === '/vendor/orders') return { body: { success: true, data: orders, meta: { total: orders.length } } };
    if (path.startsWith('/vendor/orders/')) return { body: { success: true, data: orders.find((o) => `/vendor/orders/${(o as { id: string }).id}` === path) ?? orders[0] } };
    return { status: 404, body: { success: false } };
  });
}

beforeEach(async () => {
  writes.length = 0;
  reads.length = 0;
  stubAudioContext();
  (await import('@/lib/auth')).setSelectedStore('store-1');
});

describe('the Orders home copies the app', () => {
  it('heads the page with the store and its state, like the app', async () => {
    hubApi({ open: false });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sample Kitchen' })).toBeTruthy();
    expect(screen.getByText(/^CLOSED( · TODAY .+)?$/)).toBeTruthy();
    expect(screen.getByText('You keep 100% of every order — Swift takes no commission.')).toBeTruthy();
  });

  it('shows the revenue pulse to an owner: today, the change on the same day last week, orders and waiting', async () => {
    hubApi({ role: 'OWNER' });
    renderWithQuery(<OrdersPage />);
    const pulse = await screen.findByRole('region', { name: 'Revenue today' });
    expect(await within(pulse).findByText('$15,000')).toBeTruthy();
    // 15,000 against 10,000 a week ago: up 50 %.
    expect(await within(pulse).findByText('▲ 50%')).toBeTruthy();
    expect(within(pulse).getByText(/^vs last (Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/)).toBeTruthy();
    expect(within(pulse).getByText('6')).toBeTruthy();
    expect(await within(pulse).findByText('4m avg to accept · 7d')).toBeTruthy();
    expect(within(pulse).getByText('Nothing waiting')).toBeTruthy();
  });

  it('a staff login sees the loaded board instead, and no money is asked for', async () => {
    hubApi({ role: 'STAFF', orders: [wireVendorOrder({ id: 'o1', status: 'PREPARING' })] });
    renderWithQuery(<OrdersPage />);
    const board = await screen.findByRole('region', { name: 'Loaded board' });
    expect(await within(board).findByText('0 new · 1 in progress in the latest page')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Revenue today' })).toBeNull();
    expect(reads.filter((p) => p.startsWith('/vendor/analytics'))).toEqual([]);
  });

  it('shows the first-order guide to a store that has never had an order', async () => {
    hubApi({ lifetime: 0, open: false });
    renderWithQuery(<OrdersPage />);
    const guide = await screen.findByRole('region', { name: 'Your first order' });
    expect(within(guide).getByText('The board is live.')).toBeTruthy();
    expect(await within(guide).findByText('Add photos to your menu')).toBeTruthy();
    expect(within(guide).getByText('Photos missing on 2 of 3 items')).toBeTruthy();
    expect(within(guide).getByText('Your store is closed')).toBeTruthy();
    expect(within(guide).getByText('Use the switch below to start taking orders')).toBeTruthy();
    expect(within(guide).getByText('Share your store link')).toBeTruthy();
    expect(await within(guide).findByText('https://swift.test/s/SAMPLE')).toBeTruthy();
    expect(within(guide).getByText('LISTENING FOR ORDERS')).toBeTruthy();
  });

  it('a store with past orders and nothing open is told it is caught up, not shown a guide', async () => {
    hubApi({ lifetime: 40, orders: [] });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('You are all caught up')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Your first order' })).toBeNull();
  });

  it('shows the Manage tiles with the app\'s words and server facts', async () => {
    hubApi({ role: 'OWNER' });
    renderWithQuery(<OrdersPage />);
    const grid = await screen.findByRole('region', { name: 'Manage' });
    expect(within(grid).getByText('The whole business')).toBeTruthy();
    const tile = (name: string) => within(grid).getByRole('link', { name: new RegExp(name) });
    await waitFor(() => expect(tile('Menu & inventory').textContent).toContain('2 active · 1 sold out'));
    expect(tile('Menu & inventory').textContent).toContain('1 SOLD OUT');
    expect(tile('Menu & inventory').getAttribute('href')).toBe('/dashboard/inventory');
    await waitFor(() => expect(tile('Insights').textContent).toMatch(/7d \$/));
    expect(tile('Insights').getAttribute('href')).toBe('/dashboard/insights');
    await waitFor(() => expect(tile('Hours & schedule').textContent).toContain('Daily · 8:00 AM–10:00 PM'));
    await waitFor(() => expect(tile('My QR & number').textContent).toContain('https://swift.test/s/SAMPLE'));
    expect(tile('My QR & number').textContent).toContain('ACTIVE');
    await waitFor(() => expect(tile('Order history').textContent).toContain('31 recent orders'));
    await waitFor(() => expect(tile('Billing').textContent).toMatch(/Next bill \d+ Oct/));
    expect(tile('Billing').getAttribute('href')).toBe('/dashboard/weekly-fee');
  });

  it('a staff login gets item availability instead of the Manage tiles', async () => {
    hubApi({ role: 'STAFF' });
    renderWithQuery(<OrdersPage />);
    const link = await screen.findByRole('link', { name: /Item availability/ });
    expect(link.getAttribute('href')).toBe('/dashboard/inventory');
    expect(screen.queryByRole('region', { name: 'Manage' })).toBeNull();
  });

  it('opens and closes the store, and pauses new orders, through the app\'s endpoints', async () => {
    hubApi({ role: 'OWNER', open: true, accepting: true });
    const view = renderWithQuery(<OrdersPage />);
    await view.user.click(await screen.findByRole('switch', { name: 'Store open to customers' }));
    await view.user.click(screen.getByRole('button', { name: 'Pause new orders' }));
    await waitFor(() => expect(writes).toEqual([
      { method: 'PUT', path: '/vendor/vendor/toggle-open', body: { isCurrentlyOpen: false } },
      { method: 'PUT', path: '/vendor/vendor/toggle-orders', body: { acceptingOrders: false } },
    ]));
  });

  it('turns "Deliver my own orders" on from the website', async () => {
    hubApi({ role: 'OWNER', selfDelivery: false });
    const view = renderWithQuery(<OrdersPage />);
    const control = await screen.findByRole('switch', { name: 'Deliver my own orders' });
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Swift sends the nearest rider for your delivery orders.')).toBeTruthy();
    await view.user.click(control);
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/profile', body: { selfDeliveryEnabled: true } }]));
  });

  it('a staff login sees the store state but no open, pause or self-delivery control', async () => {
    hubApi({ role: 'STAFF' });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('Open for orders')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Store open to customers' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause new orders|Resume orders/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Deliver my own orders' })).toBeNull();
  });

  it('puts the app\'s actions on the order cards: accept, reject with a reason, mark ready', async () => {
    hubApi({ orders: [
      wireVendorOrder({ id: 'o-new', orderNumber: 'SW-7001', status: 'PENDING' }),
      wireVendorOrder({ id: 'o-prep', orderNumber: 'SW-7002', status: 'PREPARING' }),
    ] });
    const view = renderWithQuery(<OrdersPage />);
    const later = await screen.findByText(/View later/).catch(() => null);
    if (later) await view.user.click(later);
    const card = (n: string) => screen.getAllByRole('article').find((a) => a.textContent?.includes(n))!;
    await waitFor(() => expect(card('#SW-7001')).toBeTruthy());
    await view.user.click(within(card('#SW-7001')).getByRole('button', { name: 'Accept' }));
    await view.user.click(within(card('#SW-7002')).getByRole('button', { name: 'Mark ready' }));
    await view.user.click(within(card('#SW-7001')).getByRole('button', { name: 'Reject' }));
    await view.user.click(within(card('#SW-7001')).getByRole('button', { name: 'Out of stock' }));
    await waitFor(() => expect(writes).toEqual([
      { method: 'PUT', path: '/vendor/orders/o-new/accept', body: {} },
      { method: 'PUT', path: '/vendor/orders/o-prep/ready', body: {} },
      { method: 'PUT', path: '/vendor/orders/o-new/reject', body: { reason: 'Out of stock' } },
    ]));
  });

  // Opus delta review of #1601, S3-A: the role is the SELECTED store's. Switching
  // to a store where this login is staff must re-read it, not keep the owner's.
  it('re-reads the role when the store changes', async () => {
    hubApi({ storeRoles: { 'store-1': 'OWNER', 'store-2': 'STAFF' } });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByRole('button', { name: 'Pause new orders' })).toBeTruthy();
    await act(async () => { (await import('@/lib/auth')).setSelectedStore('store-2'); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Pause new orders' })).toBeNull());
    expect(await screen.findByRole('region', { name: 'Loaded board' })).toBeTruthy();
  });
});

describe('the new-order takeover counts down like the app', () => {
  it('shows the server\'s accept deadline as m:ss', async () => {
    const first = wireVendorOrder({ id: 'o-old', orderNumber: 'SW-7100', status: 'PREPARING' });
    let orders: unknown[] = [first];
    mockApi(({ url }) => {
      if (url.pathname.endsWith('/vendor/orders')) return { body: { success: true, data: orders, meta: { total: orders.length } } };
      return { status: 404, body: { success: false } };
    });
    const { queryClient } = renderWithQuery(<OrdersPage />);
    await screen.findByText('#SW-7100');
    // A new order arrives with the server's deadline three minutes away.
    orders = [first, wireVendorOrder({ id: 'o-fresh', orderNumber: 'SW-7101', status: 'PENDING', respondBy: new Date(Date.now() + 180_000).toISOString() })];
    await act(async () => { await queryClient.refetchQueries(); });
    expect(await screen.findByText(/Accept within/, {}, { timeout: 5000 })).toBeTruthy();
    // m:ss, a little under three minutes however slow the run.
    expect(screen.getByText(/^[23]:\d\d$/)).toBeTruthy();
    expect(screen.getByText(/the customer is watching this clock too/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Opus review of #1615 (11 Oct), S1-1 and follow-ups: the store's state comes
// from the selected entry of GET /vendor/profile's `vendors`, and the open /
// pause / self-delivery endpoints FLIP the stored value, so the controls must
// read the real state and stay locked until it has been re-read.
// ---------------------------------------------------------------------------
describe('the store controls read the real server state', () => {
  it('a live store taking orders shows "Open for orders" and offers to pause', async () => {
    hubApi({ open: true, accepting: true });
    const view = renderWithQuery(<OrdersPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Sample Kitchen' })).toBeTruthy();
    expect(screen.getByText(/^OPEN( · TODAY .+)?$/)).toBeTruthy();
    expect(await screen.findByText('Open for orders')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Store open to customers' }).getAttribute('aria-checked')).toBe('true');
    await view.user.click(screen.getByRole('button', { name: 'Pause new orders' }));
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/vendor/toggle-orders', body: { acceptingOrders: false } }]));
  });

  it('a paused store says so and offers to resume', async () => {
    hubApi({ open: true, accepting: false });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('Orders paused')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume orders' })).toBeTruthy();
  });

  it('self-delivery that is on reads on, and turning it off sends false', async () => {
    hubApi({ selfDelivery: true });
    const view = renderWithQuery(<OrdersPage />);
    const control = await screen.findByRole('switch', { name: 'Deliver my own orders' });
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText('You deliver your orders yourself — Swift won’t send a rider.')).toBeTruthy();
    await view.user.click(control);
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor/profile', body: { selfDeliveryEnabled: false } }]));
  });

  it('a quick second tap cannot flip the store back before its new state is read', async () => {
    let release!: (_reply: { body: unknown }) => void;
    const held = new Promise<{ body: unknown }>((resolve) => { release = resolve; });
    hubApi({ open: true, holdProfileRefetch: held });
    const view = renderWithQuery(<OrdersPage />);
    const control = await screen.findByRole('switch', { name: 'Store open to customers' });
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'));
    await view.user.click(control);
    await waitFor(() => expect(writes.length).toBe(1));
    await view.user.click(control);
    await view.user.click(screen.getByRole('switch', { name: 'Store open to customers' }));
    expect(writes).toEqual([{ method: 'PUT', path: '/vendor/vendor/toggle-open', body: { isCurrentlyOpen: false } }]);
    release({ body: { success: true, data: { id: 'owner-1', userId: 'user-1', myRole: 'OWNER', vendors: [] } } });
  });

  it('a store that is not live yet cannot be opened, paused or switched to self-delivery', async () => {
    hubApi({ status: 'PENDING_REVIEW', open: false });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByText('Not open yet')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Store open to customers' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Pause new orders|Resume orders/ })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Deliver my own orders' })).toBeNull();
  });
});

describe('MMG orders on the board follow the app', () => {
  it('an unpaid MMG order offers the payment confirmation, not an Accept the server refuses', async () => {
    hubApi({ orders: [wireVendorOrder({ id: 'o-mmg', orderNumber: 'SW-7201', status: 'PENDING', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING', canConfirmPayment: true })] });
    const view = renderWithQuery(<OrdersPage />);
    const later = await screen.findByText(/View later/).catch(() => null);
    if (later) await view.user.click(later);
    const card = await screen.findByRole('article', { name: 'Order SW-7201' });
    expect(within(card).getByText('Awaiting MMG payment')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Reject' })).toBeTruthy();
    await view.user.click(within(card).getByRole('button', { name: 'Confirm MMG payment' }));
    expect(await screen.findByRole('dialog', { name: 'Order details' })).toBeTruthy();
  });

  it('a disputed MMG order says why it is paused, on the card and in the order window, and offers no forward step', async () => {
    const disputed = wireVendorOrder({ id: 'o-disp', orderNumber: 'SW-7202', status: 'PREPARING', paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED', mmgClaimMismatchAt: '2026-10-11T12:00:00Z' });
    hubApi({ orders: [disputed] });
    const view = renderWithQuery(<OrdersPage />);
    const card = await screen.findByRole('article', { name: 'Order SW-7202' });
    expect(within(card).getByText('Payment under review — order paused')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Mark ready' })).toBeNull();
    await view.user.click(within(card).getByText('#SW-7202'));
    const dialog = await screen.findByRole('dialog', { name: 'Order details' });
    expect(await within(dialog).findByText('Payment under review — order paused')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Mark ready' })).toBeNull();
  });
});

describe('the board and clock details follow the app', () => {
  it('an order in an unknown status keeps the board up instead of "all caught up"', async () => {
    hubApi({ orders: [wireVendorOrder({ id: 'o-odd', orderNumber: 'SW-7301', status: 'SOMETHING_NEW' })] });
    renderWithQuery(<OrdersPage />);
    expect(await screen.findByRole('button', { name: /Unrecognised · 1/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'New orders' })).toBeTruthy();
    expect(screen.queryByText('You are all caught up')).toBeNull();
  });

  it('the accept clock disappears once its deadline has passed', async () => {
    const first = wireVendorOrder({ id: 'o-old', orderNumber: 'SW-7400', status: 'PREPARING' });
    let orders: unknown[] = [first];
    mockApi(({ url }) => (url.pathname.endsWith('/vendor/orders') ? { body: { success: true, data: orders, meta: { total: orders.length } } } : { status: 404, body: { success: false } }));
    const { queryClient } = renderWithQuery(<OrdersPage />);
    await screen.findByText('#SW-7400');
    orders = [first, wireVendorOrder({ id: 'o-late', orderNumber: 'SW-7401', status: 'PENDING', respondBy: new Date(Date.now() - 60_000).toISOString() })];
    await act(async () => { await queryClient.refetchQueries(); });
    expect(await screen.findByText(/NEW ORDER/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/Accept within/)).toBeNull();
  });
});

// Opus delta review of #1615: the store's own confirmation lands as CLAIMED
// (never CAPTURED), and the server counts CLAIMED as money moved — so a
// confirmed MMG order offers Accept again and says so truthfully.
describe('MMG payment states on the card', () => {
  const mmgOrder = (paymentStatus: string) => wireVendorOrder({ id: 'o-mmg', orderNumber: 'SW-7501', status: 'PENDING', paymentMethod: 'MOBILE_MONEY', paymentStatus, canConfirmPayment: true });
  async function card(paymentStatus: string) {
    hubApi({ orders: [mmgOrder(paymentStatus)] });
    const view = renderWithQuery(<OrdersPage />);
    const later = await screen.findByText(/View later/).catch(() => null);
    if (later) await view.user.click(later);
    return screen.findByRole('article', { name: 'Order SW-7501' });
  }
  it('a payment the store has confirmed (CLAIMED) offers Accept, says it is confirmed, and asks for nothing more', async () => {
    const c = await card('CLAIMED');
    expect(within(c).getByText('Payment confirmed by your store')).toBeTruthy();
    expect(within(c).queryByText('Awaiting MMG payment')).toBeNull();
    expect(within(c).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Confirm MMG payment' })).toBeNull();
  });
  it('a provider-captured payment (CAPTURED) offers Accept and says it was received', async () => {
    const c = await card('CAPTURED');
    expect(within(c).getByText('MMG payment received')).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Accept' })).toBeTruthy();
  });
  it('a pending payment offers the confirmation step instead of Accept', async () => {
    const c = await card('PENDING');
    expect(within(c).getByText('Awaiting MMG payment')).toBeTruthy();
    expect(within(c).getByRole('button', { name: 'Confirm MMG payment' })).toBeTruthy();
    expect(within(c).queryByRole('button', { name: 'Accept' })).toBeNull();
  });
  it('a failed payment says why, instead of "Awaiting"', async () => {
    const c = await card('FAILED');
    expect(within(c).getByText(/MMG reports this payment as failed/)).toBeTruthy();
    expect(within(c).queryByText('Awaiting MMG payment')).toBeNull();
    expect(within(c).queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});

// Opus delta review, S3-5: the store's state is re-read every 20 s like the
// app, and a control never unlocks on a state it could not re-read.
describe('the store state stays current', () => {
  it('re-reads the store every 20 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      hubApi({});
      renderWithQuery(<OrdersPage />);
      await screen.findByRole('heading', { level: 1, name: 'Sample Kitchen' });
      const before = reads.filter((p) => p === '/vendor/profile').length;
      await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
      await waitFor(() => expect(reads.filter((p) => p === '/vendor/profile').length).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the controls locked, and says so, when the store cannot be re-read after a change', async () => {
    hubApi({ open: true, failProfileRefetch: true });
    const view = renderWithQuery(<OrdersPage />);
    const control = await screen.findByRole('switch', { name: 'Store open to customers' });
    await waitFor(() => expect(control.getAttribute('aria-checked')).toBe('true'));
    await view.user.click(control);
    expect(await screen.findByText(/Couldn.t check your store.s current state/)).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Store open to customers' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Pause new orders' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes.length).toBe(1);
  });
});

