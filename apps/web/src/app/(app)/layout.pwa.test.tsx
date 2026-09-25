import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from './layout';

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
    const { container } = render(<AppLayout><p>Home page</p></AppLayout>);
    await screen.findByText('Home page');
    expect(container.querySelector('header')?.className).toContain('pt-[env(safe-area-inset-top)]');
    expect(screen.getByRole('navigation', { name: 'Swift tabs' }).className).toContain('pb-[env(safe-area-inset-bottom)]');
    const main = container.querySelector('main')?.className ?? '';
    expect(main).toContain('env(safe-area-inset-bottom)');
    // On phones the page ends above the dock (3.5rem) and the home bar.
    expect(main).toContain('pb-[calc(5rem_+_env(safe-area-inset-bottom))]');
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
    view.rerender(<AppLayout><p>Home page</p></AppLayout>);
    await screen.findByText('Home page');
    expect(card()).not.toBeNull();
  });

  it('offers it on Home while the sign-in check is still running — Home never waits for it', async () => {
    state.sessionProbe.mockReturnValue(new Promise(() => undefined));
    render(<AppLayout><p>Home page</p></AppLayout>);
    expect(screen.getByText('Home page')).toBeTruthy();
    act(() => { window.dispatchEvent(installEvent()); });
    expect(card()).not.toBeNull();
  });

  it('rides above the phone dock, not over it', async () => {
    const { container } = render(<AppLayout><p>Home page</p></AppLayout>);
    await screen.findByText('Home page');
    act(() => { window.dispatchEvent(installEvent()); });
    expect(card()?.className).toContain('var(--swift-dock');
    // The shell says how tall the dock is: the dock plus the home bar on
    // phones, the home bar alone from md up.
    const shell = container.querySelector('.swift-app')?.className ?? '';
    expect(shell).toContain('[--swift-dock:calc(3.5rem_+_env(safe-area-inset-bottom))]');
    expect(shell).toContain('md:[--swift-dock:env(safe-area-inset-bottom)]');
  });

  it('never lays the card over the cart', async () => {
    state.pathname = '/cart';
    render(<AppLayout><p>Cart page</p></AppLayout>);
    await screen.findByText('Cart page');
    act(() => { window.dispatchEvent(installEvent()); });
    expect(card()).toBeNull();
  });
});
