import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '@/app/login/page';
import SignupPage from '@/app/signup/page';
import * as auth from './auth';
import * as customer from './customer';
import { queueStorefrontContinuation, readStorefrontContinuation, takeStorefrontContinuation } from './storefront-continuation';

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), query: '' }));
vi.mock('next/navigation', () => ({ useRouter: () => nav, useSearchParams: () => new URLSearchParams(nav.query) }));
const intent = { storeSlug: 'garden-kitchen', itemId: 'roti', selectedOptions: { filling: ['chickpea'] }, returnPath: '/store/garden-kitchen?src=qr' };
beforeEach(() => {
  auth.clearSession();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/login');
  nav.query = '';
  nav.push.mockReset();
  nav.replace.mockReset();
  vi.spyOn(auth, 'sendOtp').mockResolvedValue();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) }));
});
async function signIn() {
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001001' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
}
describe('QR-W-R2-1 auth journey cancellation', () => {
  it('preserves deliberate login → signup, then clears on Swift home', async () => {
    queueStorefrontContinuation(intent);
    const login = render(<LoginPage />);
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }));
    login.unmount();
    await Promise.resolve();
    expect(readStorefrontContinuation()).toEqual(intent);
    window.history.replaceState(null, '', `/signup?next=${encodeURIComponent(intent.returnPath)}`);
    render(<SignupPage />);
    fireEvent.click(screen.getByRole('link', { name: 'Swift home' }));
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
  it.each(['login', 'signup'])('clears %s continuation on browser Back', page => {
    queueStorefrontContinuation(intent);
    render(page === 'login' ? <LoginPage /> : <SignupPage />);
    window.history.replaceState(null, '', '/store/garden-kitchen');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
  it.each(['login', 'signup'])('clears %s continuation when leaving the document', page => {
    queueStorefrontContinuation(intent);
    render(page === 'login' ? <LoginPage /> : <SignupPage />);
    window.dispatchEvent(new Event('pagehide'));
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
  it.each(['login', 'signup'])('clears on %s route unmount, but survives Strict Mode rehearsal', async page => {
    queueStorefrontContinuation(intent);
    const view = render(<StrictMode>{page === 'login' ? <LoginPage /> : <SignupPage />}</StrictMode>);
    await Promise.resolve();
    expect(readStorefrontContinuation()).toEqual(intent);
    view.unmount();
    await waitFor(() => expect(readStorefrontContinuation()).toBeNull());
  });
  it('preserves the deliberate signup → login handoff', async () => {
    queueStorefrontContinuation(intent);
    const view = render(<SignupPage />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }));
    expect(nav.push).toHaveBeenCalledWith(`/login?next=${encodeURIComponent(intent.returnPath)}`);
    view.unmount();
    await Promise.resolve();
    expect(readStorefrontContinuation()).toEqual(intent);
  });
});
function tabStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() { return entries.size; },
  };
}
describe('QR-W-R2-2 cross-tab epoch', () => {
  it.each(['logout', 'account-change', 'probe-account-change', 'probe-sign-out'])('blocks tab A replay after tab B %s, even before a storage event', async action => {
    const tabA = tabStorage();
    const tabB = tabStorage();
    // Separate tab session stores and auth modules share only localStorage.
    vi.resetModules();
    const authB = await import('./auth');
    vi.stubGlobal('sessionStorage', tabA);
    queueStorefrontContinuation(intent);
    vi.stubGlobal('sessionStorage', tabB);
    if (action === 'logout') await authB.logout();
    else {
      authB.adoptSession('first-account');
      vi.stubGlobal('sessionStorage', tabA);
      queueStorefrontContinuation(intent);
      vi.stubGlobal('sessionStorage', tabB);
      if (action === 'account-change') authB.adoptSession('second-account');
      else {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: action !== 'probe-sign-out', json: async () => ({ data: { user: { id: 'second-account' } } }) }));
        await authB.sessionProbe();
      }
    }
    vi.stubGlobal('sessionStorage', tabA);
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
    expect(tabA.getItem('swift_storefront_add')).toBeNull();
  });
  it('clears the stale selection when the storage event reaches the other tab', async () => {
    queueStorefrontContinuation(intent);
    const original = sessionStorage;
    vi.resetModules();
    const authB = await import('./auth');
    vi.stubGlobal('sessionStorage', tabStorage());
    authB.clearSession();
    vi.stubGlobal('sessionStorage', original);
    window.dispatchEvent(new StorageEvent('storage', { key: 'swift_storefront_epoch' }));
    expect(sessionStorage.getItem('swift_storefront_add')).toBeNull();
  });
  it('keeps this tab’s deliberate guest login and consumes the selection once', async () => {
    queueStorefrontContinuation(intent);
    vi.spyOn(customer, 'verifyCustomerLogin').mockImplementation(async () => {
      auth.adoptSession('new-customer');
      return { user: { id: 'new-customer' } };
    });
    const view = render(<LoginPage />);
    await signIn();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(intent.returnPath));
    view.unmount();
    await Promise.resolve();
    expect(takeStorefrontContinuation(intent.storeSlug)).toEqual(intent);
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
  it('fails closed without throwing when shared storage is blocked', () => {
    queueStorefrontContinuation(intent);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, clear: () => {} });
    expect(readStorefrontContinuation()).toBeNull();
    expect(() => auth.adoptSession('new-customer')).not.toThrow();
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
});
describe('QR-W-R2-3 explicit unrelated next supersedes the pending store', () => {
  it.each(['/cart', '/store/store-b'])('discards before login and returns to %s without later replay', async destination => {
    queueStorefrontContinuation(intent);
    nav.query = `next=${encodeURIComponent(destination)}`;
    vi.spyOn(customer, 'verifyCustomerLogin').mockResolvedValue({ user: { id: 'customer' } });
    const view = render(<LoginPage />);
    expect(readStorefrontContinuation()).toBeNull();
    expect(screen.queryByRole('link', { name: 'Cancel and return to menu' })).toBeNull();
    await signIn();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(destination));
    view.unmount();
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
  it('also discards an unrelated direct signup destination', () => {
    queueStorefrontContinuation(intent);
    window.history.replaceState(null, '', '/signup?next=/cart');
    render(<SignupPage />);
    expect(takeStorefrontContinuation(intent.storeSlug)).toBeNull();
  });
  it('preserves a next path bound to the same store', () => {
    queueStorefrontContinuation(intent);
    nav.query = 'next=/store/garden-kitchen';
    render(<LoginPage />);
    expect(readStorefrontContinuation()).toEqual(intent);
  });
});
