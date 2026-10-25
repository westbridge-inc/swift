import { act, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppLayout from './layout';

const state = vi.hoisted(() => ({
  pathname: '/order/search',
  replace: vi.fn(),
  push: vi.fn(),
  back: vi.fn(),
  principal: null as string | null,
  sessionProbe: vi.fn(),
  restoreSession: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ replace: state.replace, push: state.push, back: state.back }),
}));
vi.mock('@/lib/auth', () => ({
  sessionProbe: state.sessionProbe,
  restoreSession: state.restoreSession,
  getSessionPrincipal: () => state.principal,
  subscribeSession: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
vi.mock('@/components/swift-logo', () => ({ SwiftLogo: () => <span>Swift</span> }));

const signedIn = (id: string) => () => { state.principal = id; return Promise.resolve({ ok: true, user: { id } }); };
const signedOut = () => { state.principal = null; return Promise.resolve({ ok: false }); };

beforeEach(() => {
  state.pathname = '/order/search';
  state.principal = null;
  state.listeners.clear();
  state.sessionProbe.mockImplementation(signedOut);
  state.restoreSession.mockImplementation(signedOut);
  // The shell reads the Market verdict once; the catalogue is not deep enough.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { visible: false, items: 3, vendors: 1 } }))));
});

// ---------------------------------------------------------------------------
// [Q7b] Who may open what in the customer app. Browsing is public, like the
// phone app; a private page opened by a guest shows a sign-in door INSIDE the
// app (the tabs stay), never the page's content. The server is asked once per
// page load; later changes arrive from lib/auth, not from re-asking on every
// page change.
// ---------------------------------------------------------------------------

describe('guest access in the customer shell', () => {
  it('renders search for a guest without redirecting to login, or spending a refresh', async () => {
    render(<AppLayout><p>Catalogue search</p></AppLayout>);
    await waitFor(() => expect(state.sessionProbe).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Catalogue search')).toBeTruthy();
    expect(state.replace).not.toHaveBeenCalled();
    expect(state.restoreSession).not.toHaveBeenCalled();
  });

  it('never shows a private page to a guest who leaves search: it tries the refresh cookie once, then offers sign-in in place', async () => {
    const view = render(<AppLayout><p>Catalogue search</p></AppLayout>);
    await waitFor(() => expect(state.sessionProbe).toHaveBeenCalledTimes(1));
    state.pathname = '/account';
    view.rerender(<AppLayout><p>Private account</p></AppLayout>);
    expect(screen.queryByText('Private account')).toBeNull();
    const door = await screen.findByRole('region', { name: 'You’re browsing as a guest' });
    expect(screen.queryByText('Private account')).toBeNull();
    expect(within(door).getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2Faccount');
    expect(within(door).getByRole('link', { name: 'Create an account' }).getAttribute('href')).toBe('/signup?next=%2Faccount');
    expect(state.restoreSession).toHaveBeenCalledTimes(1);
    expect(state.sessionProbe).toHaveBeenCalledTimes(1);
    expect(state.replace).not.toHaveBeenCalled();
  });

  it('a customer whose access cookie expired is restored, not asked to sign in again', async () => {
    state.pathname = '/account';
    state.restoreSession.mockImplementation(signedIn('c1'));
    render(<AppLayout><p>Private account</p></AppLayout>);
    await screen.findByText('Private account');
    expect(state.restoreSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'You’re browsing as a guest' })).toBeNull();
  });

  it('keeps an authenticated visitor signed in across pages without asking the server again', async () => {
    state.pathname = '/account';
    state.sessionProbe.mockImplementation(signedIn('c1'));
    const view = render(<AppLayout><p>Private account</p></AppLayout>);
    await screen.findByText('Private account');
    state.pathname = '/order/search';
    view.rerender(<AppLayout><p>Catalogue search</p></AppLayout>);
    expect(screen.getByText('Catalogue search')).toBeTruthy();
    state.pathname = '/account';
    view.rerender(<AppLayout><p>Private account</p></AppLayout>);
    expect(screen.getByText('Private account')).toBeTruthy();
    expect(state.sessionProbe).toHaveBeenCalledTimes(1);
    expect(state.restoreSession).not.toHaveBeenCalled();
  });

  it('closes private pages the moment the session ends mid-visit (sign-out, or the server ending it)', async () => {
    state.pathname = '/account';
    state.sessionProbe.mockImplementation(signedIn('c1'));
    render(<AppLayout><p>Private account</p></AppLayout>);
    await screen.findByText('Private account');
    act(() => {
      state.principal = null;
      for (const listener of state.listeners) listener();
    });
    expect(screen.queryByText('Private account')).toBeNull();
    expect(screen.getByRole('heading', { name: 'You’re browsing as a guest' })).toBeTruthy();
    // The server already ended it: no refresh is spent trying to revive it.
    expect(state.restoreSession).not.toHaveBeenCalled();
  });

  it('still renders authenticated private pages', async () => {
    state.pathname = '/account';
    state.sessionProbe.mockImplementation(signedIn('c1'));
    render(<AppLayout><p>Private account</p></AppLayout>);
    await waitFor(() => expect(screen.queryByText('Private account')).not.toBeNull());
    expect(state.replace).not.toHaveBeenCalled();
  });
});
