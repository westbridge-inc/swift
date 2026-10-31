import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, stubAudioContext, type ApiRequest } from '@/test/test-utils';

// ---------------------------------------------------------------------------
// [SPEED 30 Oct · owner] Switching tabs in the business console feels instant.
//
// The console shell stays up while its pages change (Next.js keeps the
// dashboard layout mounted), so this harness does the same: one DashboardShell,
// its page swapped by re-render. Once the board has loaded, every new read is
// HELD (never answered), so whatever a tab shows next came from what the console
// already had: a tab that still needs the network shows its loading words.
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({ path: '/dashboard/orders' }));
// One router for the page's life, as Next gives (a new one per render would re-run the session check forever).
const router = vi.hoisted(() => ({ replace: () => undefined, push: () => undefined }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => nav.path }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth')>();
  return { ...real, sessionProbe: vi.fn().mockResolvedValue({ ok: true, user: { id: 'u1', firstName: 'Sample' } }) };
});

import { setSelectedStore } from '@/lib/auth';
import { DashboardShell } from './dashboard-shell';
import OrdersPage from './orders/page';
import InventoryPage from './inventory/page';
import SettingsPage from './settings/page';
import SchedulePage from './schedule/page';
import InsightsPage from './insights/page';
import WeeklyFeePage from './weekly-fee/page';

type Role = 'OWNER' | 'MANAGER' | 'STAFF';
const net = { hold: false, held: [] as Array<() => void>, reads: [] as string[] };

function storeApi({ role = 'OWNER' as Role, vendorType = 'RESTAURANT' } = {}) {
  const ok = (data: unknown) => ({ body: { success: true, data } });
  const answer = (path: string) => {
    if (path === '/vendor/stores') return ok({ stores: [{ id: 'store-1', name: 'Sample Kitchen', vendorType, isCurrentlyOpen: true, acceptingOrders: true, city: null, isVerified: true }], selectedId: 'store-1', myRole: role });
    if (path === '/vendor/profile') return ok({ id: 'owner-1', userId: 'user-1', myRole: role, vendors: [{ id: 'store-1', name: 'Sample Kitchen', vendorType, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, acceptingOrders: true, selfDeliveryEnabled: false, operatingHours: [], _count: { orders: 40, items: 2 } }] });
    if (path === '/vendor/orders') return { body: { success: true, data: [], meta: { total: 0 } } };
    if (path === '/vendor/items') return ok([
      { id: 'i1', name: 'Pepperpot bowl', basePrice: '1500.00', isAvailable: true, imageUrl: null, category: { id: 'c1', name: 'Mains' } },
      { id: 'i2', name: 'Sorrel', basePrice: '500.00', isAvailable: false, imageUrl: null, category: { id: 'c2', name: 'Drinks' } },
    ]);
    if (path === '/vendor/categories') return ok([{ id: 'c1', name: 'Mains' }, { id: 'c2', name: 'Drinks' }]);
    if (path === '/vendor/hours') return ok([0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openTime: '08:00', closeTime: '22:00', isClosed: false })));
    if (path === '/vendor/subscription') return ok({ status: 'ACTIVE', feeStatus: { state: 'DUE', headline: 'Payment due since 18 Oct 2026', detail: 'GY$15,000 to pay.', date: '2026-10-18T12:00:00.000Z' }, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 15000, currencyCode: 'GYD' }] });
    if (path === '/vendor/cash-settlements') return ok({ settlements: [], totalOwed: 0 });
    if (path === '/vendor/vat') return ok({ available: true, status: 'NONE', vatRegistrationNumber: null, ratePercent: 14, effective: false, certificate: null });
    if (path === '/verification/status') return ok({ foodHandlerAttestation: { tick: 'Everyone who handles food here holds a valid food handler\'s certificate.', version: 'fh-1', stores: [{ vendorId: 'store-1', name: 'Sample Kitchen', attested: false }] } });
    if (path === '/vendor/analytics/overview') return ok({ vendor: { averageRating: 4.8, totalRatings: 12, totalOrders: 40 }, today: { orders: 6, revenue: 15000 }, week: { orders: 31, revenue: 77500 }, month: { orders: 118, revenue: 295000 }, activeMenuItems: 2 });
    if (path === '/vendor/analytics/revenue') return ok({ daily: [], totals: { orders: 0 } });
    if (path === '/vendor/analytics/ops') return ok({ avgAcceptMinutes: 4 });
    if (path === '/vendor/qr') return ok({ shortUrl: 'https://swift.test/s/SAMPLE', status: 'ACTIVE' });
    if (path === '/vendor/vendor/delivery-status') return ok({ deliveryOpen: true, reason: null, waitingForRider: 0, backlogCap: 10, message: null });
    if (path === '/vendor/bookings') return ok([]);
    if (path === '/vendor/bookings/exceptions') return ok([]);
    return { status: 404, body: { success: false } };
  };
  return mockApi(({ method, url }: ApiRequest) => {
    const path = url.pathname.replace('/api/v1', '');
    if (method !== 'GET') return { body: { success: true, data: {} } };
    net.reads.push(path);
    if (net.hold) return new Promise((resolve) => { net.held.push(() => resolve(answer(path))); });
    return answer(path);
  });
}

/** Lets the console finish everything it starts on its own (reads, then whatever follows them). */
async function settle() {
  let seen = -1;
  for (let rounds = 0; rounds < 60 && seen !== net.reads.length; rounds += 1) {
    seen = net.reads.length;
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 40); }); });
  }
}

const shell = (page: ReactNode) => <DashboardShell>{page}</DashboardShell>;
/** Opens the console on the Orders home and lets it settle, then holds the network. */
async function openConsole(opts: { role?: Role; vendorType?: string } = {}) {
  storeApi(opts);
  setSelectedStore('store-1');
  const view = render(shell(<OrdersPage />));
  await screen.findByText(/You keep 100% of every order/);
  await settle();
  return view;
}
/** A tab tap: the page changes and React draws once; nothing on the network is answered. */
async function tapTab(view: ReturnType<typeof render>, path: string, page: ReactNode) {
  net.hold = true;
  nav.path = path;
  view.rerender(shell(page));
  await act(async () => { await Promise.resolve(); });
}

// The first test pays for loading every page module once.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  stubAudioContext();
  vi.stubGlobal('WebSocket', undefined);
  net.hold = false; net.held = []; net.reads = [];
  nav.path = '/dashboard/orders';
});
afterEach(() => { net.held.splice(0).forEach((release) => release()); localStorage.clear(); });

describe('a first tap on a tab shows its content at once (its reads were made while the board sat idle)', () => {
  it('the owner\'s Menu tab: rows under their sections, no "Loading your menu…"', async () => {
    const view = await openConsole();
    await tapTab(view, '/dashboard/inventory', <InventoryPage />);
    expect(screen.queryByText('Loading your menu…')).toBeNull();
    expect(screen.getByRole('region', { name: 'Mains' }).textContent).toContain('Pepperpot bowl');
    expect(screen.getByRole('region', { name: 'Drinks' }).textContent).toContain('Sorrel');
  });

  it('the owner\'s Account tab: what you owe riders, VAT and food handlers drawn, no "Checking…"', async () => {
    const view = await openConsole();
    await tapTab(view, '/dashboard/settings', <SettingsPage />);
    expect(screen.queryByText('Checking what you owe riders…')).toBeNull();
    expect(screen.queryByText('Checking your subscription…')).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('heading', { name: 'VAT' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your food handlers' })).toBeTruthy();
    expect(screen.getByText('Payment due since 18 Oct 2026', { exact: false })).toBeTruthy();
  });

  it('the Account tab asks Swift for the store\'s VAT once, not twice (one read feeds the card and the report link)', async () => {
    const view = await openConsole();
    await tapTab(view, '/dashboard/settings', <SettingsPage />);
    net.hold = false; net.held.splice(0).forEach((release) => release());
    await settle();
    expect(net.reads.filter((path) => path === '/vendor/vat')).toHaveLength(1);
  });

  it('a Services store manager\'s Schedule tab: the agenda, not "Loading your schedule…"', async () => {
    const view = await openConsole({ role: 'MANAGER', vendorType: 'SERVICE' });
    await tapTab(view, '/dashboard/schedule', <SchedulePage />);
    expect(screen.queryByText('Loading your schedule…')).toBeNull();
  });

  it('staff: their Availability and Account tabs are instant, and nothing a staff member cannot see is ever read', async () => {
    const view = await openConsole({ role: 'STAFF' });
    await tapTab(view, '/dashboard/inventory', <InventoryPage />);
    expect(screen.queryByText('Loading your menu…')).toBeNull();
    expect(screen.getByRole('region', { name: 'Mains' }).textContent).toContain('Pepperpot bowl');
    await tapTab(view, '/dashboard/settings', <SettingsPage />);
    expect(screen.queryByText('Checking what you owe riders…')).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();
    const ownerOnly = ['/vendor/vat', '/vendor/subscription', '/verification/status', '/vendor/analytics/overview', '/vendor/bookings', '/vendor/bookings/exceptions'];
    expect(net.reads.filter((path) => ownerOnly.includes(path))).toEqual([]);
  });

  it('a Restaurant\'s manager reads no Schedule (a Services-only tab) and no owner-only VAT, fee or food-handler read', async () => {
    await openConsole({ role: 'MANAGER' });
    const notTheirs = ['/vendor/vat', '/vendor/subscription', '/verification/status', '/vendor/bookings', '/vendor/bookings/exceptions'];
    expect(net.reads.filter((path) => notTheirs.includes(path))).toEqual([]);
  });
});

describe('a tab left for a while still opens with what it showed', () => {
  it('back on Orders after 6 minutes on the Menu: the board at once, no "Loading your orders…"', async () => {
    const view = await openConsole();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await tapTab(view, '/dashboard/inventory', <InventoryPage />);
      net.hold = false; net.held.splice(0).forEach((release) => release());
      await settle();
      await act(async () => { vi.advanceTimersByTime(6 * 60_000); });
      await tapTab(view, '/dashboard/orders', <OrdersPage />);
      expect(screen.queryByText('Loading your orders…')).toBeNull();
      expect(screen.getByText('No active orders shown')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('money shown from memory says it is being checked until Swift answers', () => {
  it('the weekly fee, opened again: last known status plus "Checking for the latest…", then the answer', async () => {
    const view = await openConsole();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      nav.path = '/dashboard/weekly-fee';
      view.rerender(shell(<WeeklyFeePage />));
      await screen.findByTestId('weekly-fee-status');
      await settle();
      await tapTab(view, '/dashboard/orders', <OrdersPage />);
      net.hold = false; net.held.splice(0).forEach((release) => release());
      await settle();
      await act(async () => { vi.advanceTimersByTime(30_000); });
      await tapTab(view, '/dashboard/weekly-fee', <WeeklyFeePage />);
      expect(screen.getByTestId('weekly-fee-status').textContent).toBe('Payment due since 18 Oct 2026');
      expect(screen.getByText('Checking for the latest…')).toBeTruthy();
      const pay = () => screen.getByRole('button', { name: /^Pay .* with MMG$/ }) as HTMLButtonElement;
      expect(pay().disabled, 'no paying on a status from memory').toBe(true);
      await act(async () => { net.held.splice(0).forEach((release) => release()); });
      await settle();
      expect(screen.queryByText('Checking for the latest…')).toBeNull();
      expect(pay().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Insights, opened again after a while: the figures plus "Checking for the latest…"', async () => {
    const view = await openConsole();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await tapTab(view, '/dashboard/insights', <InsightsPage />);
      net.hold = false; net.held.splice(0).forEach((release) => release());
      await settle();
      await tapTab(view, '/dashboard/orders', <OrdersPage />);
      net.hold = false; net.held.splice(0).forEach((release) => release());
      await settle();
      net.hold = true; // the board's own figure polls go out and wait, as on a slow line
      await act(async () => { vi.advanceTimersByTime(40_000); });
      await tapTab(view, '/dashboard/insights', <InsightsPage />);
      expect(screen.getByText('Orders today')).toBeTruthy();
      expect(screen.getByText('Checking for the latest…')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
