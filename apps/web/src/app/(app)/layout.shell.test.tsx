import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from './layout';

const state = vi.hoisted(() => ({
  pathname: '/',
  principal: null as string | null,
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
  sessionProbe: vi.fn(),
  marketVisible: false,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: state.push, back: state.back, replace: state.replace }),
}));
vi.mock('@/lib/auth', () => ({
  sessionProbe: state.sessionProbe,
  restoreSession: vi.fn().mockResolvedValue({ ok: false }),
  getSessionPrincipal: () => state.principal,
  subscribeSession: () => () => undefined,
}));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

beforeEach(() => {
  state.pathname = '/';
  state.principal = 'c1';
  state.marketVisible = false;
  state.sessionProbe.mockImplementation(() => Promise.resolve({ ok: true, user: { id: 'c1' } }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: { visible: state.marketVisible, items: state.marketVisible ? 400 : 12, vendors: state.marketVisible ? 9 : 1 },
  }))));
});

/** Move to another page of the app, the way Next does: same shell, new page. */
function go(view: ReturnType<typeof render>, pathname: string, page: string) {
  state.pathname = pathname;
  view.rerender(<AppLayout><p>{page}</p></AppLayout>);
}

// ---------------------------------------------------------------------------
// [Q7b] The shell of the customer app behaves like the phone app: it asks the
// server who is browsing ONCE per page load, keeps its header and tabs on
// screen while pages change underneath, and never blanks the screen with a
// full-page "Loading…" between pages.
// ---------------------------------------------------------------------------

describe('[Q7b] the shell stays put while pages change', () => {
  it('asks who is browsing once, and keeps the same header and tabs on screen across pages', async () => {
    const view = render(<AppLayout><p>Home page</p></AppLayout>);
    await screen.findByText('Home page');
    const header = screen.getByRole('banner');
    const tabs = screen.getByRole('navigation', { name: 'Swift tabs' });

    go(view, '/order/browse', 'Browse page');
    expect(screen.getByText('Browse page')).toBeTruthy();
    go(view, '/order/vendor/v1', 'Store page');
    expect(screen.getByText('Store page')).toBeTruthy();
    go(view, '/cart', 'Cart page');
    expect(screen.getByText('Cart page')).toBeTruthy();
    go(view, '/account', 'Profile page');
    expect(screen.getByText('Profile page')).toBeTruthy();

    expect(screen.getByRole('banner')).toBe(header);
    expect(screen.getByRole('navigation', { name: 'Swift tabs' })).toBe(tabs);
    expect(screen.queryByText(/Loading…/)).toBeNull();
    expect(state.sessionProbe).toHaveBeenCalledTimes(1);
  });

  it('shows a public page at once, and a private page’s shape — inside the chrome — while the one check is answered', async () => {
    let answer: (_value: { ok: boolean }) => void = () => undefined;
    state.sessionProbe.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const view = render(<AppLayout><p>Home page</p></AppLayout>);
    expect(screen.getByText('Home page')).toBeTruthy();

    go(view, '/cart', 'Cart page');
    expect(screen.queryByText('Cart page')).toBeNull();
    expect(screen.getByLabelText('Opening this page')).toBeTruthy();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Swift tabs' })).toBeTruthy();
    expect(screen.queryByText(/Loading…/)).toBeNull();

    await act(async () => { answer({ ok: true }); });
    expect(screen.getByText('Cart page')).toBeTruthy();
  });
});

describe('[Q7b] the phone app’s tabs', () => {
  it('docks Home · Cart · Profile at the bottom on phone widths only, lighting the current one', async () => {
    state.pathname = '/cart';
    render(<AppLayout><p>Cart page</p></AppLayout>);
    await screen.findByText('Cart page');
    const dock = screen.getByRole('navigation', { name: 'Swift tabs' });
    // Visible below md, fixed to the bottom; gone from md up, where the top
    // bar carries the same places.
    expect(dock.className).toContain('md:hidden');
    expect(dock.className).toContain('fixed');
    expect(dock.className).toContain('bottom-0');
    const links = within(dock).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Home', 'Cart', 'Profile']);
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/', '/cart', '/account']);
    expect(within(dock).getByRole('link', { name: 'Cart' }).getAttribute('aria-current')).toBe('page');
    expect(within(dock).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });

  it('adds Market as the second tab only when the server says the catalogue is deep enough', async () => {
    state.marketVisible = true;
    render(<AppLayout><p>Home page</p></AppLayout>);
    const dock = screen.getByRole('navigation', { name: 'Swift tabs' });
    await waitFor(() => expect(within(dock).getAllByRole('link').map((link) => link.textContent)).toEqual(['Home', 'Market', 'Cart', 'Profile']));
  });

  it('lights Profile for its inner pages, and Home for a store', async () => {
    state.pathname = '/orders/o1';
    const view = render(<AppLayout><p>Tracking page</p></AppLayout>);
    await screen.findByText('Tracking page');
    const dock = screen.getByRole('navigation', { name: 'Swift tabs' });
    expect(within(dock).getByRole('link', { name: 'Profile' }).getAttribute('aria-current')).toBe('page');
    go(view, '/order/vendor/v1', 'Store page');
    expect(within(dock).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('[Q7b] the marketing site is one tap away', () => {
  it('links Sell on Swift, Drive with Swift and About from the slim top bar', async () => {
    render(<AppLayout><p>Home page</p></AppLayout>);
    await screen.findByText('Home page');
    const strip = screen.getByRole('navigation', { name: 'Swift for business' });
    expect(within(strip).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Sell on Swift', '/vendors'],
      ['Drive with Swift', '/drivers'],
      ['About', '/about'],
    ]);
  });

  it('opens the same pages from the phone menu, with sign-in for a guest', async () => {
    state.principal = null;
    state.sessionProbe.mockResolvedValue({ ok: false });
    render(<AppLayout><p>Home page</p></AppLayout>);
    await waitFor(() => expect(state.sessionProbe).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'More from Swift' }));
    const menu = screen.getByRole('dialog', { name: 'More from Swift' });
    const hrefs = within(menu).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(expect.arrayContaining(['/vendors', '/drivers', '/about', '/welcome']));
    await waitFor(() => expect(within(menu).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2F'));
  });
});

describe('[Q7b] in-app back buttons — an installed web app has no browser back', () => {
  it.each([
    ['a store', '/order/vendor/v1', '/'],
    ['the cart and checkout', '/cart', '/'],
    ['order tracking', '/orders/o1', '/orders'],
  ])('%s opened directly goes back to its parent page', async (_name, pathname, parent) => {
    state.pathname = pathname;
    render(<AppLayout><p>Page</p></AppLayout>);
    await screen.findByText('Page');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(state.push).toHaveBeenCalledWith(parent);
    expect(state.back).not.toHaveBeenCalled();
  });

  it('goes back through the app’s own history when there is some', async () => {
    const view = render(<AppLayout><p>Home page</p></AppLayout>);
    await screen.findByText('Home page');
    go(view, '/order/vendor/v1', 'Store page');
    go(view, '/cart', 'Cart page');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(state.back).toHaveBeenCalledTimes(1);
    expect(state.push).not.toHaveBeenCalled();
  });

  it('has no back button on a tab’s own first page', async () => {
    const view = render(<AppLayout><p>Home page</p></AppLayout>);
    await screen.findByText('Home page');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    go(view, '/account', 'Profile page');
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });
});
