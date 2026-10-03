import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Window } from 'happy-dom';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { StorefrontDetail } from './api';

const route = vi.hoisted(() => ({ pathname: '/signup', router: { replace: vi.fn(), push: vi.fn() } }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname, useRouter: () => route.router,
  useSearchParams: () => new URLSearchParams('next=%2Fstore%2Ftest') }));
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const deferred = <T,>() => {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
async function browser(pathname = '/signup') {
  vi.resetModules(); route.pathname = pathname; route.router.replace.mockReset(); route.router.push.mockReset();
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', pathname);
  const announce = vi.fn(); vi.stubGlobal('BroadcastChannel', class { postMessage = announce; });
  const fetcher = vi.fn(async (input: RequestInfo | URL, _options?: RequestInit) => String(input).endsWith('/auth/me')
    ? response({ user: { id: 'a', roles: ['VENDOR'] } }) : response({}));
  vi.stubGlobal('fetch', fetcher);
  const auth = await import('./auth');
  return { auth, fetcher, announce };
}
async function signupOtp() {
  const { default: Signup } = await import('@/app/signup/page'); render(<Signup />);
  fireEvent.click(screen.getByRole('button', { name: /Order on Swift/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001003' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  fireEvent.change(await screen.findByLabelText('Verification code'), { target: { value: '246810' } });
}
it.each(['verify', 'register'] as const)('AX440 F1 real signup %s ignores stale JSON after B and preserves the newer pending send', async (kind) => {
  const { auth, fetcher, announce } = await browser(); await signupOtp();
  if (kind === 'register') {
    fetcher.mockResolvedValueOnce(response({ isNewUser: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Account' } });
  }
  const body = deferred<unknown>();
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise } as Response);
  fireEvent.click(screen.getByRole('button', { name: kind === 'verify' ? 'Continue' : 'Create account' }));
  await act(async () => undefined);
  act(() => auth.adoptSession('b')); const epoch = auth.currentSessionEpoch(); announce.mockClear();
  fireEvent.click(screen.getByRole('button', { name: /Order on Swift/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001004' } });
  const sending = deferred<Response>(); fetcher.mockReturnValueOnce(sending.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  await act(async () => body.resolve({ success: true, data: { isNewUser: false, user: { id: 'a', roles: ['CUSTOMER'] } } }));
  expect(auth.getSessionPrincipal()).toBe('b'); expect(auth.currentSessionEpoch()).toBe(epoch);
  expect(announce).not.toHaveBeenCalled(); expect(route.router.replace).not.toHaveBeenCalled(); expect(route.router.push).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByLabelText('Phone number') as HTMLInputElement).value).toBe('+5926001004');
  expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByLabelText('Phone number'), { key: 'Enter' });
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/send-otp'))).toHaveLength(2);
  await act(async () => sending.resolve(response({})));
  expect(screen.getByText(/Enter the code sent to/).textContent).toContain('+5926001004');
});
it.each(['verify', 'register'] as const)('AX440 F1 actual %s helper rejects stale adoption and current adoption still works', async (kind) => {
  const { auth, fetcher, announce } = await browser();
  const { verifyOtp, registerAccount } = await import('./customer');
  const invoke = () => kind === 'verify' ? verifyOtp('+5926001003', '246810')
    : registerAccount({ phone: '+5926001003', firstName: 'Test', lastName: 'Account', role: 'CUSTOMER' });
  const body = deferred<unknown>(); fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => body.promise } as Response);
  const old = invoke().catch((error: unknown) => error); await Promise.resolve(); auth.adoptSession('b');
  const epoch = auth.currentSessionEpoch(); announce.mockClear();
  body.resolve({ success: true, data: { user: { id: 'a' } } });
  expect(await old).toMatchObject({ code: 'SESSION_CHANGED', status: 409 });
  expect(auth.getSessionPrincipal()).toBe('b'); expect(auth.currentSessionEpoch()).toBe(epoch); expect(announce).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(response({ user: { id: 'c' } })); await invoke();
  expect(auth.getSessionPrincipal()).toBe('c'); expect(auth.currentSessionEpoch()).toBe(epoch + 1); expect(announce).toHaveBeenCalledTimes(1);
});

const uncertain = [
  ['offline', () => Promise.reject(new TypeError('offline'))], ['503', async () => new Response(null, { status: 503 })],
  ['429', async () => new Response(null, { status: 429 })], ['invalid JSON', async () => new Response('invalid-json')],
  ['missing identity', async () => response({ user: null })],
] as const;
it.each(uncertain)('AX440 F2 isolated tab %s preserves real sibling dashboard dirty hours, store, appointments and response context', async (_kind, outcome) => {
  const siblingWindow = window;
  const uncertainWindow = new Window({ url: 'http://localhost/account' });
  const values = new Map<string, string>(); const deliveries: (() => void)[] = [];
  const storage = (peer: typeof window): Storage => ({
    get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null, clear: () => values.clear(),
    setItem: (key, value) => { const oldValue = values.get(key) ?? null; values.set(key, value);
      deliveries.push(() => peer.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: value }))); },
    removeItem: (key) => { const oldValue = values.get(key) ?? null; if (!values.delete(key)) return;
      deliveries.push(() => peer.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: null }))); },
  });
  const firstStorage = storage(siblingWindow); const secondStorage = storage(uncertainWindow as unknown as typeof window);
  Object.defineProperty(uncertainWindow, 'localStorage', { value: firstStorage });
  const base = await browser('/account');
  vi.stubGlobal('window', uncertainWindow); vi.stubGlobal('localStorage', firstStorage);
  base.auth.adoptSession('a');
  const { SessionBoundary } = await import('@/components/providers');
  let firstClient!: QueryClient;
  function PrivateDraft() { firstClient = useQueryClient(); return <p>Uncertain private draft</p>; }
  const firstView = render(<SessionBoundary><PrivateDraft /></SessionBoundary>);
  firstClient.setQueryData(['private'], 'private account a');
  vi.stubGlobal('window', siblingWindow); vi.stubGlobal('localStorage', secondStorage);
  vi.resetModules(); const sibling = await import('./auth'); sibling.adoptSession('a'); sibling.setSelectedStore('store-a');
  const { DashboardShell } = await import('@/app/dashboard/dashboard-shell');
  const { default: Settings } = await import('@/app/dashboard/settings/page');
  const { dirtyDraftIds } = await import('./store-scope');
  route.pathname = '/dashboard/settings';
  base.fetcher.mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith('/auth/me')) return response({ user: { id: 'a' } });
    if (path.endsWith('/stores')) return response({ stores: [{ id: 'store-a', name: 'Store A' }], selectedId: 'store-a' });
    if (path.endsWith('/hours')) return response([{ dayOfWeek: 0, openTime: '08:00', closeTime: '20:00', isClosed: false }]);
    return response(null);
  });
  const siblingView = render(<DashboardShell><Settings /></DashboardShell>);
  await within(siblingView.container).findByRole('button', { name: 'Save hours' });
  const field = siblingView.container.querySelector('input[type=time]') as HTMLInputElement;
  fireEvent.change(field, { target: { value: '09:45' } }); expect(dirtyDraftIds()).toContain('Operating hours');
  values.set('swift_web_appointments', 'sibling appointment'); deliveries.splice(0); base.announce.mockClear();
  const pending = deferred<Response>(); base.fetcher.mockReturnValueOnce(pending.promise);
  const request = sibling.apiFetch('/api/v1/vendor/pending', undefined, { storeId: 'store-a' });
  const siblingEpoch = sibling.currentSessionEpoch();
  vi.stubGlobal('window', uncertainWindow); vi.stubGlobal('localStorage', firstStorage);
  base.fetcher.mockImplementationOnce(outcome);
  await act(async () => uncertainWindow.dispatchEvent(new uncertainWindow.Event('focus')));
  await waitFor(() => expect(base.auth.getSessionPrincipal()).toBeNull());
  expect(within(firstView.container).getByText('Uncertain private draft').closest('[hidden][inert]')).toBeTruthy();
  expect(firstClient.getQueryCache().getAll()).toHaveLength(0);
  vi.stubGlobal('window', siblingWindow); vi.stubGlobal('localStorage', secondStorage);
  expect(values.get('swift_web_store')).toBe('store-a');
  expect(deliveries).toHaveLength(0);
  await act(async () => deliveries.splice(0).forEach((deliver) => deliver()));
  expect(sibling.getSelectedStore()).toBe('store-a'); expect(sibling.getSessionPrincipal()).toBe('a'); expect(sibling.currentSessionEpoch()).toBe(siblingEpoch);
  expect(values.get('swift_web_appointments')).toBe('sibling appointment'); expect(base.announce).not.toHaveBeenCalled();
  expect(siblingView.container.querySelector('input[type=time]')).toBe(field); expect(field.value).toBe('09:45'); expect(dirtyDraftIds()).toContain('Operating hours');
  pending.resolve(response({ kept: true })); await expect(request).resolves.toMatchObject({ data: { kept: true } });
  expect(base.fetcher.mock.calls.find(([url]) => String(url).endsWith('/vendor/pending'))?.[1]?.headers).toMatchObject({ 'x-vendor-id': 'store-a' });
  act(() => sibling.clearSession()); expect(values.has('swift_web_appointments')).toBe(false); expect(sibling.getSelectedStore()).toBeNull();
});

const store: StorefrontDetail = {
  id: 'test', slug: 'test', name: 'Public store', description: null, vendorType: 'RESTAURANT', logoUrl: null, coverImageUrl: null,
  city: 'Test city', region: 'Test region', cuisineTypes: [], tags: [], displayRating: null, ratingBucket: 'NEW', ratingCount: 0,
  topRated: false, isCurrentlyOpen: true, acceptingOrders: true, estimatedPrepTime: 10, minOrderAmount: 0, isFeatured: false,
  addressLine1: 'Public address', operatingHours: [], categories: [{ id: 'food', name: 'Food', items: [{ id: 'meal', name: 'Public meal',
    description: null, basePrice: 500, imageUrl: null, unit: null, isPopular: false, fulfillment: 'DELIVERY' }] }],
};
for (const surface of ['storefront', 'selfie'] as const) {
  it.each(['newer first', 'obsolete first'] as const)(`AX440 F3 real ${surface} follows current same-epoch proof: %s`, async (order) => {
    const { auth, fetcher } = await browser(surface === 'selfie' ? '/selfie' : '/store/test'); auth.adoptSession('a');
    const epoch = auth.currentSessionEpoch(); const old = deferred<Response>(); const fresh = deferred<Response>(); let proofs = 0;
    fetcher.mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith('/auth/me')) { proofs += 1; return proofs === 1 ? old.promise : proofs === 2 ? fresh.promise : response({ user: { id: 'a' } }); }
      if (path.endsWith('/addresses')) return response([{ id: 'address-a', label: 'Home', addressLine1: 'Private street a', city: 'Test' }]);
      if (path.endsWith('/cart')) return response({ items: [{ id: 'line-a', itemId: 'meal', name: 'Private cart a', quantity: 1, customerPrice: 500, fulfillment: 'DELIVERY' }], vendor: { id: 'test', name: store.name } });
      return response({ ...store, categories: store.categories.map((category) => ({ ...category, items: category.items.map((item) => ({ ...item, isAvailable: true })) })) });
    });
    if (surface === 'storefront') {
      const { StorefrontExperience } = await import('@/components/storefront/storefront-experience'); render(<StorefrontExperience store={store} returnPath="/store/test" />);
      await screen.findByText(/Live menu checked/);
    } else {
      const stop = vi.fn(); Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) } });
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      vi.spyOn(HTMLMediaElement.prototype, 'srcObject', 'set').mockImplementation(() => undefined);
      const { default: Selfie } = await import('@/app/selfie/page'); render(<Selfie />);
      fireEvent.click(screen.getByRole('button', { name: 'Turn on front camera' })); await screen.findByRole('button', { name: 'Take photo now' });
    }
    await act(async () => window.dispatchEvent(new Event('pageshow'))); expect(screen.getByRole('status').textContent).toBe('Checking your account…');
    if (order === 'obsolete first') {
      await act(async () => old.resolve(response({ user: { id: 'a' } })));
      expect(screen.getByRole('status')).toBeTruthy(); expect(route.router.replace).not.toHaveBeenCalled();
      expect(screen.queryByRole('option', { name: /Private street a/ })).toBeNull();
    }
    await act(async () => fresh.resolve(response({ user: { id: 'a' } })));
    if (order === 'newer first') await act(async () => old.resolve(response({ user: { id: 'a' } })));
    expect(auth.currentSessionEpoch()).toBe(epoch); expect(auth.getSessionPrincipal()).toBe('a'); expect(screen.queryByRole('status')).toBeNull();
    expect(route.router.replace).not.toHaveBeenCalled();
    if (surface === 'storefront') {
      await screen.findByRole('option', { name: /Private street a/ }); expect(screen.getAllByText(/Private cart a/).length).toBeGreaterThan(0);
      fireEvent.click(screen.getAllByRole('button', { name: 'Add another Public meal' })[0]!);
      await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/cart/items/line-a'))).toBe(true));
      expect(route.router.push).not.toHaveBeenCalled();
    } else expect(screen.getByRole('button', { name: 'Take photo now' })).toBeTruthy();
  });
}

for (const surface of ['dashboard', 'portal', 'weekly-fee'] as const) {
  it(`AX440 census ${surface} waits for replacement proof without treating obsolete as sign-out`, async () => {
    const { auth, fetcher } = await browser(`/${surface}`); auth.adoptSession('a');
    const old = deferred<Response>(); const fresh = deferred<Response>(); let proofs = 0;
    fetcher.mockImplementation(async (input) => String(input).endsWith('/auth/me')
      ? (++proofs === 1 ? old.promise : proofs === 2 ? fresh.promise : response({ user: { id: 'a', roles: ['VENDOR'] } }))
      : response({ stores: [] }));
    if (surface === 'dashboard') {
      const { DashboardShell } = await import('@/app/dashboard/dashboard-shell'); render(<DashboardShell><p>Private dashboard</p></DashboardShell>);
    } else if (surface === 'portal') {
      const { PortalShell } = await import('@/app/portal/portal-shell'); render(<PortalShell><p>Private portal</p></PortalShell>);
    } else {
      const { WeeklyFeeDestination } = await import('@/components/weekly-fee-destination'); render(<WeeklyFeeDestination />);
    }
    const newer = auth.verifySessionNow({ fresh: true });
    await act(async () => old.resolve(response({ user: { id: 'a' } })));
    expect(route.router.replace).not.toHaveBeenCalled(); expect(screen.queryByText('Private portal')).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/refresh'))).toBe(false);
    await act(async () => { fresh.resolve(response({ user: { id: 'a', roles: ['VENDOR'] } })); await newer; });
    if (surface === 'portal') await screen.findByText('Private portal');
    else if (surface === 'dashboard') await screen.findByText('Choose a store to continue.');
    else await waitFor(() => expect(route.router.replace).toHaveBeenCalledWith('/dashboard/weekly-fee'));
    expect(route.router.replace.mock.calls.flat().some((value) => String(value).startsWith('/login'))).toBe(false);
  });
  it(`AX440 census ${surface} does not redirect on current inconclusive proof`, async () => {
    const { fetcher } = await browser(`/${surface}`); fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    if (surface === 'dashboard') {
      const { DashboardShell } = await import('@/app/dashboard/dashboard-shell'); render(<DashboardShell><p>Private dashboard</p></DashboardShell>);
    } else if (surface === 'portal') {
      const { PortalShell } = await import('@/app/portal/portal-shell'); render(<PortalShell><p>Private portal</p></PortalShell>);
    } else {
      const { WeeklyFeeDestination } = await import('@/components/weekly-fee-destination'); render(<WeeklyFeeDestination />);
    }
    await act(async () => undefined); expect(route.router.replace).not.toHaveBeenCalled();
    expect(screen.queryByText('Private dashboard')).toBeNull(); expect(screen.queryByText('Private portal')).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/auth/refresh'))).toBe(false);
  });
}

it('AX440 F2 conclusive sign-out after uncertainty still retires retained shared store and appointments', async () => {
  const { auth, fetcher, announce } = await browser('/account'); auth.adoptSession('a'); auth.setSelectedStore('store-a');
  localStorage.setItem('swift_web_appointments', 'private appointment'); announce.mockClear();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 503 })); await auth.verifySessionNow();
  expect(auth.getSessionPrincipal()).toBeNull(); expect(auth.getSelectedStore()).toBe('store-a');
  expect(localStorage.getItem('swift_web_appointments')).toBe('private appointment'); expect(announce).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  expect(await auth.verifySessionNow()).toMatchObject({ signedOut: true });
  expect(auth.getSelectedStore()).toBeNull(); expect(localStorage.getItem('swift_web_appointments')).toBeNull(); expect(announce).toHaveBeenCalledTimes(1);
});

it.each(['verify', 'register'] as const)('AX440 F1 delayed %s delivery after legitimate adoption cannot navigate or unlock B signup', async (kind) => {
  const { auth, fetcher, announce } = await browser();
  const customer = await import('./customer'); const delivery = deferred<void>();
  if (kind === 'verify') {
    const actual = customer.verifyOtp;
    vi.spyOn(customer, 'verifyOtp').mockImplementation(async (...args) => { const result = await actual(...args); await delivery.promise; return result; });
  } else {
    const actual = customer.registerAccount;
    vi.spyOn(customer, 'registerAccount').mockImplementation(async (...args) => { const result = await actual(...args); await delivery.promise; return result; });
  }
  await signupOtp();
  if (kind === 'register') {
    fetcher.mockResolvedValueOnce(response({ isNewUser: true })); fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Account' } });
  }
  fetcher.mockResolvedValueOnce(response({ user: { id: 'a', roles: ['CUSTOMER'] } }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: kind === 'verify' ? 'Continue' : 'Create account' })));
  expect(auth.getSessionPrincipal()).toBe('a'); act(() => auth.adoptSession('b')); announce.mockClear();
  fireEvent.click(screen.getByRole('button', { name: /Order on Swift/ }));
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value: '+5926001004' } });
  const sending = deferred<Response>(); fetcher.mockReturnValueOnce(sending.promise); fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  await act(async () => delivery.resolve());
  expect(route.router.replace).not.toHaveBeenCalled(); expect(auth.getSessionPrincipal()).toBe('b'); expect(announce).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => sending.resolve(response({})));
  expect(screen.getByText(/Enter the code sent to/).textContent).toContain('+5926001004');
});

it('AX440 F3 real selfie does not turn current offline uncertainty into a login redirect', async () => {
  const { fetcher } = await browser('/selfie'); fetcher.mockRejectedValue(new TypeError('offline'));
  const { default: Selfie } = await import('@/app/selfie/page'); render(<Selfie />);
  await act(async () => undefined); expect(route.router.replace).not.toHaveBeenCalled();
});
