import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from './layout';
import CartPage from './cart/page';
import * as api from '@/lib/customer';

const state = vi.hoisted(() => ({ pathname: '/', principal: null as string | null, replace: vi.fn(), sessionProbe: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname, useRouter: () => ({ replace: state.replace, push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/lib/auth', () => ({
  sessionProbe: state.sessionProbe,
  restoreSession: vi.fn().mockResolvedValue({ ok: false }),
  getSessionPrincipal: () => state.principal,
  subscribeSession: () => () => undefined,
}));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

// ---------------------------------------------------------------------------
// [PWA-1] The customer shell as an installed app: clear of the notch and the
// home bar, and offering the install card on the home page — including when
// the browser's install event lands while another page is on screen.
// [Q7b] Home is `/` now, and the phone dock sits between the page and the
// home bar, so the card rides above the dock.
// ---------------------------------------------------------------------------

function installEvent() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, { prompt: vi.fn().mockResolvedValue(undefined) });
  return event;
}

const card = () => screen.queryByRole('complementary', { name: 'Install Swift' });

beforeEach(() => {
  state.pathname = '/';
  state.principal = 'c1';
  state.sessionProbe.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { visible: false, items: 0, vendors: 0 } }))));
});

describe('[PWA-1] the customer shell, installed', () => {
  it('pads the header below the status bar, the dock above the home bar, and ends the page above both', async () => {
    const { container } = render(<AppLayout><button>Home page</button></AppLayout>);
    await screen.findByText('Home page');
    fireEvent.click(screen.getByText('Home page'));
    fireEvent.click(screen.getByText('Home page'));
    // [WEB-REDESIGN] Phones have no top bar: the page itself starts below the
    // status bar, and so does the side rail from 760 px.
    const main = container.querySelector('main')?.className ?? '';
    expect(main).toContain('pt-[env(safe-area-inset-top)]');
    expect(container.querySelector('header')?.className).toContain('env(safe-area-inset-top)');
    expect(screen.getByRole('navigation', { name: 'Swift tabs' }).className).toContain('pb-[env(safe-area-inset-bottom)]');
    // On phones the page ends above the dock and the home bar (--swift-dock).
    expect(main).toContain('pb-[calc(var(--swift-dock)_+_40px)]');
  });

  it('catches the install event on another page, and offers it once Home is reached', async () => {
    state.pathname = '/cart';
    const view = render(<AppLayout><p>Cart page</p></AppLayout>);
    await screen.findByText('Cart page');

    const event = installEvent();
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(card()).toBeNull();

    state.pathname = '/';
    view.rerender(<AppLayout><button>Home page</button></AppLayout>);
    await screen.findByText('Home page');
    fireEvent.click(screen.getByText('Home page'));
    fireEvent.click(screen.getByText('Home page'));
    expect(card()).not.toBeNull();
  });

  it('offers it on Home while the sign-in check is still running — Home never waits for it', async () => {
    state.sessionProbe.mockReturnValue(new Promise(() => undefined));
    render(<AppLayout><button>Home page</button></AppLayout>);
    expect(screen.getByText('Home page')).toBeTruthy();
    fireEvent.click(screen.getByText('Home page'));
    fireEvent.click(screen.getByText('Home page'));
    act(() => { window.dispatchEvent(installEvent()); });
    expect(card()).not.toBeNull();
  });

  it('rides above the phone dock, not over it', async () => {
    const { container } = render(<AppLayout><button>Home page</button></AppLayout>);
    await screen.findByText('Home page');
    fireEvent.click(screen.getByText('Home page'));
    fireEvent.click(screen.getByText('Home page'));
    act(() => { window.dispatchEvent(installEvent()); });
    expect(card()?.className).toContain('var(--swift-dock');
    // The shell says how tall the dock is: the dock (60 px, the design's) plus
    // the home bar on phones, the home bar alone from 760 px up.
    const shell = container.querySelector('.swift-app')?.className ?? '';
    expect(shell).toContain('[--swift-dock:calc(60px_+_env(safe-area-inset-bottom))]');
    expect(shell).toContain('wide:[--swift-dock:env(safe-area-inset-bottom)]');
    const clearance = container.querySelector('[data-install-clearance]');
    expect(clearance?.parentElement).toBe(container.querySelector('.swift-app'));
    expect(container.querySelector('main')!.compareDocumentPosition(clearance!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(['/cart', '/orders/order-1'])('suppresses an engaged, available offer on %s', async (pathname) => {
    state.pathname = pathname;
    const view = render(<AppLayout><button>Review order</button></AppLayout>);
    await screen.findByText('Review order');
    fireEvent.click(screen.getByText('Review order'));
    fireEvent.click(screen.getByText('Review order'));
    act(() => { window.dispatchEvent(installEvent()); });
    expect(card()).toBeNull();
    // Same engagement and offer: Home is the positive control for suppression.
    state.pathname = '/';
    view.rerender(<AppLayout><button>Home page</button></AppLayout>);
    expect(card()).not.toBeNull();
  });

  it('preserves a mounted cart and its typed delivery address through disconnect and reconnect', async () => {
    state.pathname = '/cart';
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    vi.spyOn(api, 'getCart').mockResolvedValue({ items: [{ id: 'l1', itemId: 'i1', name: 'Lunch box', quantity: 1, customerPrice: 500, isAvailable: true }], vendor: { id: 'v1', name: 'Local store' }, subtotalCustomer: 500 } as api.Cart);
    vi.spyOn(api, 'getAddresses').mockResolvedValue([]);
    render(<AppLayout><CartPage /></AppLayout>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a delivery address' }));
    const address = screen.getByRole('textbox', { name: 'Search the delivery destination' }) as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'Test destination, Georgetown' } });
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByText('You’re offline.')).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByText('You’re offline.')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Search the delivery destination' })).toBe(address);
    expect(address.value).toBe('Test destination, Georgetown');
  });
});
