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
  it('switching app from a console marks where you are and only navigates: it never changes the account role on the server', async () => {
    const seen: string[] = [];
    mockApi(({ url }) => {
      seen.push(url.pathname);
      if (url.pathname.endsWith('/public/capabilities')) return { body: { success: true, data: { adsEnabled: false } } };
      return { status: 404, body: { success: false } };
    });
    push.mockClear();
    const onClose = vi.fn();
    const view = renderWithQuery(<SwitchAppSheet current="vendor" onClose={onClose} />);
    const sheet = await screen.findByRole('dialog', { name: 'Switch app' });
    // Where you are is a close button, not a link back to itself.
    const here = within(sheet).getByRole('button', { name: /Swift Business/ });
    expect(here.getAttribute('aria-current')).toBe('true');
    expect(within(sheet).queryByRole('link', { name: /Swift Business/ })).toBeNull();
    // The other web apps are plain links: the customer app from a console goes home.
    expect(within(sheet).getByRole('link', { name: /^Swift\s?Order food/ }).getAttribute('href')).toBe('/');
    expect(within(sheet).getByRole('link', { name: /Swift Driver/ }).getAttribute('href')).toBe('/portal');
    await waitFor(() => expect(seen).toContain('/api/v1/public/capabilities'));
    // Advertising switched off on the server: no door to the ads pages.
    expect(within(sheet).queryByRole('link', { name: /Swift Ads/ })).toBeNull();
    await view.user.click(here);
    expect(onClose).toHaveBeenCalled();
    // A role switch on the server would also flip the phone app and can take a
    // rider off duty; the web office never needs one.
    expect(seen.some((path) => path.endsWith('/switch-role'))).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
  it('opens Swift Ads on the web only while the server says advertising is on', async () => {
    mockApi(({ url }) => url.pathname.endsWith('/public/capabilities')
      ? { body: { success: true, data: { adsEnabled: true } } }
      : { status: 404, body: { success: false } });
    renderWithQuery(<SwitchAppSheet onClose={vi.fn()} />);
    const sheet = await screen.findByRole('dialog', { name: 'Switch app' });
    const ads = await within(sheet).findByRole('link', { name: /Swift Ads/ });
    expect(ads.getAttribute('href')).toBe('/advertiser');
    expect(ads.textContent).toContain('Your campaigns and advertising account');
    // In the customer app, the customer row is still "you are here".
    expect(within(sheet).getByRole('button', { name: /^Swift\s?Order food/ }).getAttribute('aria-current')).toBe('true');
  });
  it('renders new, preparing and ready simultaneously using the existing buckets', async () => {
    stubAudioContext();
    const rows = ['PENDING', 'PREPARING', 'RIDER_ASSIGNED', 'FAILED', 'NEW_STATUS'].map((status, i) => ({ ...wireVendorOrder(), id: `board-${i}`, orderNumber: `P2-${i}`, status }));
    mockApi(() => ({ body: { success: true, data: rows, meta: { total: 5 } } }));
    const view = renderWithQuery(<OrdersPage />);
    await screen.findByText('#P2-0');
    const later = screen.queryByText(/View later/);
    if (later) await view.user.click(later);
    for (const [label, number] of [['New', '0'], ['Preparing', '1'], ['Ready / handoff', '2']]) {
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
