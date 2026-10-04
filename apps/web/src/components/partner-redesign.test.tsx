import { render, screen, within, waitFor } from '@testing-library/react';
import { describe, it, vi } from 'vitest';
import { LayoutDashboard, Receipt } from 'lucide-react';
import { ConsoleShell } from './console-shell';
import { SwitchAppSheet } from './customer-shell';
import { mockApi, renderWithQuery, stubAudioContext } from '@/test/test-utils';
import { wireVendorOrder } from '@/test/vendor-wire-fixtures';
import OrdersPage from '@/app/dashboard/orders/page';
import TodayPage from '@/app/dashboard/page';
import { expect } from 'vitest';
const push = vi.fn();
vi.mock('next/navigation', () => ({ usePathname: () => '/portal', useRouter: () => ({ push, replace: vi.fn() }) }));

describe('partner redesign', () => {
  it('shows office tabs in a 760px rail and phone dock without customer or job tabs', () => {
    render(<ConsoleShell home="/portal" title="Earner" navigation={[
      { href: '/portal', label: 'Earnings', icon: LayoutDashboard, exact: true },
      { href: '/portal/weekly-fee', label: 'Weekly fee', icon: Receipt, exact: true },
    ]} signOutBody="Sign out"><p>Office</p></ConsoleShell>);
    const dock = screen.getByRole('navigation', { name: 'Earner tabs' });
    expect(dock.className).toContain('wide:hidden');
    expect(within(dock).getByRole('link', { name: 'Earnings' }).getAttribute('aria-current')).toBe('page');
    expect(within(dock).queryByRole('link', { name: 'Cart' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go online' })).toBeNull();
    expect(screen.getByText('Prices in GYD')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Switch app/ }).length).toBeGreaterThan(0);
  });
  it('switches to business through the existing server transition before navigating', async () => {
    let release!: (_v: { body: unknown }) => void;
    const seen: unknown[] = [];
    mockApi(({ url, init }) => {
      if (url.pathname.endsWith('/auth/me')) return { body: { success: true, data: { user: { id: 'role-test', roles: ['CUSTOMER', 'VENDOR_OWNER'], activeRole: 'CUSTOMER' } } } };
      if (url.pathname.endsWith('/customer/switch-role')) {
        seen.push(JSON.parse(String(init?.body)));
        return new Promise((resolve) => { release = resolve; });
      }
      return { body: { success: true, data: [] } };
    });
    push.mockClear();
    const view = renderWithQuery(<SwitchAppSheet onClose={vi.fn()} />);
    await view.user.click(await screen.findByRole('button', { name: /Swift Business/ }));
    await waitFor(() => expect(seen).toEqual([{ role: 'VENDOR' }]));
    expect(push).not.toHaveBeenCalled();
    release({ body: { success: true, data: { activeRole: 'VENDOR_OWNER' } } });
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dashboard/orders'));
  });
  it('keeps the current app when the server refuses a role transition', async () => {
    mockApi(({ url }) => url.pathname.endsWith('/auth/me')
      ? { body: { success: true, data: { user: { id: 'role-test', roles: ['CUSTOMER', 'VENDOR_OWNER'] } } } }
      : { status: 409, body: { success: false, error: { message: 'Finish your active job first.' } } });
    push.mockClear();
    const view = renderWithQuery(<SwitchAppSheet onClose={vi.fn()} />);
    await view.user.click(await screen.findByRole('button', { name: /Swift Business/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Finish your active job first.');
    expect(push).not.toHaveBeenCalled();
  });
  it('renders new, preparing and ready simultaneously using the existing buckets', async () => {
    stubAudioContext();
    const rows = ['PENDING', 'PREPARING', 'RIDER_ASSIGNED', 'FAILED', 'NEW_STATUS'].map((status, i) => ({ ...wireVendorOrder(), id: `board-${i}`, orderNumber: `P2-${i}`, status }));
    mockApi(() => ({ body: { success: true, data: rows, meta: { total: 5 } } }));
    const view = renderWithQuery(<OrdersPage />);
    await screen.findByText('#P2-0');
    const later = screen.queryByText(/View later/);
    if (later) await view.user.click(later);
    for (const [label, number] of [['New', '0'], ['Preparing', '1'], ['Ready', '2']]) {
      expect(within(screen.getByRole('region', { name: `${label} orders` })).getByText(`#P2-${number}`)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: /Needs attention/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Unrecognised/ })).toBeTruthy();
  });
  it('sends the inverse server open state through the existing toggle endpoint', async () => {
    const writes: unknown[] = [];
    mockApi(({ url, method, init }) => {
      if (method === 'PUT') { writes.push({ path: url.pathname, body: JSON.parse(String(init?.body)) }); return { body: { success: true } }; }
      if (url.pathname.endsWith('/low-stock')) return { body: { success: true, data: [] } };
      return { body: { success: true, data: { vendor: { isCurrentlyOpen: true, acceptingOrders: true, averageRating: 5, totalRatings: 1 }, today: { orders: 0, revenue: 0 }, week: { orders: 0, revenue: 0 }, month: { orders: 0, revenue: 0 } } } };
    });
    const view = renderWithQuery(<TodayPage />);
    await view.user.click(await screen.findByRole('switch', { name: 'Store open' }));
    await waitFor(() => expect(writes).toEqual([{ path: '/api/v1/vendor/vendor/toggle-open', body: { isCurrentlyOpen: false } }]));
  });
});
