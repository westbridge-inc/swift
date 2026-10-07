import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { adoptSession } from '@/lib/auth';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { CustomerSessionProvider, type CustomerSession } from '@/components/customer-session';
import CartPage from '@/app/(app)/cart/page';
import AccountPage from '@/app/(app)/account/page';
import AddressesPage from '@/app/(app)/account/addresses/page';
import ProfilePage from '@/app/(app)/account/profile/page';
import FavouritesPage from '@/app/(app)/account/favourites/page';
import SafetyPage from '@/app/(app)/account/safety/page';
import HelpPage from '@/app/(app)/account/help/page';
import { FavouriteButton } from './favourites';
import { AccountBoundary } from './account-frame';
import type { Address, Favourite, Ticket } from './account-api';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => '/account' }));
const signedIn: CustomerSession = { status: 'signed-in', scope: 'test-customer', epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined };
const sessionView = (children: ReactNode, session = signedIn) => <CustomerSessionProvider value={session}>{children}</CustomerSessionProvider>;
const home: Address = { id: 'home', label: 'Home', addressLine1: 'Test Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1, isDefault: true };
const work: Address = { ...home, id: 'work', label: 'Work', addressLine1: 'Test Avenue', isDefault: false };
let addresses: Address[];
let favourites: Favourite[];
let tickets: Ticket[];
let marketing: boolean;
let calls: ApiRequest[];
let failWrite: boolean;
const profile = { id: 'test-customer', firstName: 'Test', lastName: 'Customer', phone: '+5920000000', email: 'test@example.test' };
const ok = (data: unknown) => ({ body: { success: true, data } });
const genericError = 'Something went wrong. Please try again.';
const rawError = 'Internal upstream diagnostic';
const unsafeErrors = [
  { name: '5xx with a known code', status: 503, body: { error: { code: 'VALIDATION_ERROR', message: rawError } } },
  { name: '5xx with an internal code', status: 500, body: { error: { code: 'INTERNAL_ERROR', message: rawError } } },
  { name: '4xx with an unknown code', status: 400, body: { error: { code: 'UNKNOWN_ERROR', message: rawError } } },
  { name: '4xx without a code', status: 400, body: { error: { message: rawError } } },
  { name: 'an unknown response shape', status: 400, body: { message: rawError } },
  { name: 'a non-4xx failure envelope', status: 200, body: { success: false, error: { code: 'VALIDATION_ERROR', message: rawError } } },
  { name: 'a network failure', status: 0, body: null },
];

function api() {
  return mockApi((request) => {
    calls.push(request);
    const { url, method, init } = request;
    const path = url.pathname.replace('/api/v1/customer', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (failWrite && method !== 'GET') return { status: 503, body: { error: { message: 'Please try again.' } } };
    if (path === '/profile') return ok(method === 'GET' ? profile : { ...profile, ...body });
    if (path === '/consent') return ok({ consents: [{ documentType: 'marketing_consent', state: marketing ? 'granted' : 'withdrawn', current: true }] });
    if (path === '/consent/marketing' && method === 'POST') { marketing = body.granted; return ok({ marketing }); }
    if (path === '/favorites' && method === 'GET') return ok(favourites);
    if (path === '/favorites/store-1') { favourites = method === 'DELETE' ? [] : [{ id: 'store-1', name: 'Test Store' }]; return ok({ message: 'Saved' }); }
    if (path === '/addresses' && method === 'GET') return ok(addresses);
    if (path === '/addresses' && method === 'POST') { const row = { ...body, id: 'new-address', isDefault: body.isDefault || addresses.length === 0 }; if (row.isDefault) addresses = addresses.map((a) => ({ ...a, isDefault: false })); addresses.push(row); return ok(row); }
    if (path.endsWith('/default') && method === 'PUT') { const id = path.split('/')[2]; addresses = addresses.map((a) => ({ ...a, isDefault: a.id === id })); return ok(addresses.find((a) => a.id === id)); }
    if (path.startsWith('/addresses/') && method === 'PUT') { addresses = addresses.map((a) => a.id === path.split('/')[2] ? { ...a, ...body } : a); return ok(addresses.find((a) => a.id === path.split('/')[2])); }
    if (path.startsWith('/addresses/') && method === 'DELETE') { addresses = addresses.filter((a) => a.id !== path.split('/')[2]); if (!addresses.some((a) => a.isDefault) && addresses[0]) addresses[0].isDefault = true; return ok({ message: 'Removed' }); }
    if (path === '/support' && method === 'GET') return ok(tickets);
    if (path === '/support' && method === 'POST') { const ticket = { id: 'ticket', subject: body.subject, status: 'OPEN' }; tickets.push(ticket); return ok(ticket); }
    if (url.pathname === '/api/v1/places/autocomplete') return ok([{ placeId: 'place-1', primary: 'Mapped Test Street', lat: 6.81, lng: -58.12 }]);
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  });
}

beforeEach(() => {
  adoptSession('test-customer');
  addresses = [{ ...home }, { ...work }]; favourites = []; tickets = []; marketing = false; calls = []; failWrite = false;
});

describe('account parity through cookie-authenticated API contracts', () => {
  it('loads the account and links every capability, retaining the shared logout confirmation', async () => {
    api(); const { user } = renderWithQuery(sessionView(<AccountPage />));
    await screen.findByText('Test Customer');
    for (const route of ['favourites', 'addresses', 'profile', 'help', 'safety']) expect(document.querySelector(`a[href="/account/${route}"]`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByRole('dialog', { name: 'Sign out of Swift?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Stay signed in' }));
    expect(calls.some((call) => call.url.pathname.endsWith('/logout'))).toBe(false);
  });

  it.each([
    ['account', <AccountPage key="account" />], ['addresses', <AddressesPage key="addresses" />], ['profile', <ProfilePage key="profile" />],
    ['favourites', <FavouritesPage key="favourites" />], ['safety', <SafetyPage key="safety" />],
  ])('keeps the %s page behind its guest door without a private read', async (_name, page) => {
    api(); renderWithQuery(sessionView(page, { ...signedIn, status: 'guest', scope: 'guest' }));
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('keeps order help behind a guest door with its return context', async () => {
    api(); renderWithQuery(sessionView(await HelpPage({ searchParams: Promise.resolve({ orderId: 'order-1' }) }), { ...signedIn, status: 'guest', scope: 'guest' }));
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login?next=%2Faccount%2Fhelp%3ForderId%3Dorder-1');
    expect(calls).toHaveLength(0);
  });

  it('saves profile names and email, keeps phone read-only, and changes marketing consent', async () => {
    api(); const { user } = renderWithQuery(sessionView(<ProfilePage />));
    const first = await screen.findByLabelText('First name');
    await user.clear(first); await user.type(first, 'Updated');
    await user.clear(screen.getByLabelText('Email')); await user.type(screen.getByLabelText('Email'), 'updated@example.test');
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).readOnly).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await screen.findByText('Your details are saved.');
    const update = calls.find((c) => c.method === 'PUT')!;
    expect(update.url.pathname).toBe('/api/v1/customer/profile');
    expect(JSON.parse(String(update.init?.body))).toEqual({ firstName: 'Updated', lastName: 'Customer', email: 'updated@example.test' });
    await user.click(screen.getByRole('checkbox', { name: /Marketing messages/ }));
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
    const consent = calls.find((c) => c.url.pathname.endsWith('/consent/marketing'))!;
    expect(consent.method).toBe('POST');
    expect(consent.url.pathname).toBe('/api/v1/customer/consent/marketing');
    expect(JSON.parse(String(consent.init?.body))).toEqual({ granted: true });
    expect(consent.init?.headers).toMatchObject({ 'x-client-platform': 'web', 'X-Swift-Client': 'web' });
    expect(calls.every((c) => c.init?.credentials === 'include' && c.init?.cache === 'no-store')).toBe(true);
  });

  it('locks profile fields until the submitted update finishes', async () => {
    let finish!: (_value: ReturnType<typeof ok>) => void;
    const normal = api();
    mockApi((request) => {
      if (request.url.pathname === '/api/v1/customer/profile' && request.method === 'PUT') return new Promise((resolve) => { finish = resolve; });
      return normal(request.url.toString(), request.init).then(async (response) => ({ status: response.status, body: await response.json() }));
    });
    const { user } = renderWithQuery(sessionView(<ProfilePage />));
    const first = await screen.findByLabelText('First name');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    expect(first.closest('fieldset')?.disabled).toBe(true);
    await user.type(first, ' Unsaved'); expect((first as HTMLInputElement).value).toBe('Test');
    await act(async () => { finish(ok(profile)); });
    await screen.findByText('Your details are saved.');
    expect(first.closest('fieldset')?.disabled).toBe(false);
  });

  it('serializes favourite writes across separate hearts for the same store', async () => {
    let finish!: (_value: ReturnType<typeof ok>) => void;
    let writes = 0;
    const normal = api();
    mockApi((request) => {
      if (request.url.pathname === '/api/v1/customer/favorites/store-1' && request.method === 'POST') { writes += 1; return new Promise((resolve) => { finish = resolve; }); }
      return normal(request.url.toString(), request.init).then(async (response) => ({ status: response.status, body: await response.json() }));
    });
    const { user } = renderWithQuery(sessionView(<AccountBoundary><FavouriteButton vendorId="store-1" name="Test Store" /><FavouriteButton vendorId="store-1" name="Test Store" /></AccountBoundary>));
    const buttons = screen.getAllByRole('button', { name: 'Save Test Store to favourites' }) as HTMLButtonElement[];
    await waitFor(() => expect(buttons[0]!.disabled).toBe(false));
    await user.click(buttons[0]!);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    await user.click(buttons[1]!); expect(writes).toBe(1);
    await act(async () => { favourites = [{ id: 'store-1', name: 'Test Store' }]; finish(ok({ message: 'Saved' })); });
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove Test Store from favourites' })).toHaveLength(2));
  });

  it('adds and removes the same store across two hearts and the favourites list', async () => {
    api(); const { user } = renderWithQuery(sessionView(<><FavouritesPage /><FavouriteButton vendorId="store-1" name="Test Store" /></>));
    await screen.findByText('No favourites yet. Save a store with its heart.');
    const save = screen.getByRole('button', { name: 'Save Test Store to favourites' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false)); await user.click(save);
    await screen.findByRole('link', { name: 'Test Store' });
    const hearts = screen.getAllByRole('button', { name: 'Remove Test Store from favourites' });
    expect(hearts).toHaveLength(2); hearts.forEach((heart) => expect(heart.getAttribute('aria-pressed')).toBe('true'));
    await user.click(hearts[0]!);
    await screen.findByText('No favourites yet. Save a store with its heart.');
    expect(screen.getByRole('button', { name: 'Save Test Store to favourites' }).getAttribute('aria-pressed')).toBe('false');
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url.pathname, c.init?.body])).toEqual([
      ['POST', '/api/v1/customer/favorites/store-1', '{}'], ['DELETE', '/api/v1/customer/favorites/store-1', undefined],
    ]);
  });

  it('offers guest store saving through sign-in without loading favourites', () => {
    api(); renderWithQuery(sessionView(<FavouriteButton vendorId="store-1" name="Test Store" />, { ...signedIn, status: 'guest', scope: 'guest' }));
    expect(screen.getByRole('link', { name: 'Sign in to save Test Store' }).getAttribute('href')).toBe('/login?next=%2Forder%2Fvendor%2Fstore-1');
    expect(calls).toHaveLength(0);
  });

  it('keeps a failed favourite write unsaved with a visible error', async () => {
    api(); const { user } = renderWithQuery(sessionView(<AccountBoundary><FavouriteButton vendorId="store-1" name="Test Store" /></AccountBoundary>));
    const save = await screen.findByRole('button', { name: 'Save Test Store to favourites' });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false)); failWrite = true; await user.click(save);
    await screen.findByRole('alert'); expect(save.getAttribute('aria-pressed')).toBe('false');
  });

  it('changes the default through the dedicated endpoint and invalidates the Home address cache', async () => {
    api(); const { user, queryClient } = renderWithQuery(sessionView(<AddressesPage />));
    queryClient.setQueryData(['customer', 'addresses', 'test-customer'], addresses);
    await user.click(await screen.findByRole('button', { name: 'Make Work default' }));
    await screen.findByRole('button', { name: 'Make Home default' });
    expect(screen.queryByRole('button', { name: 'Make Work default' })).toBeNull();
    expect(within(screen.getByRole('heading', { name: 'Work Default' })).getByText('Default')).toBeTruthy();
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url.pathname, c.init?.body])).toEqual([['PUT', '/api/v1/customer/addresses/work/default', undefined]]);
    expect(queryClient.getQueryState(['customer', 'addresses', 'test-customer'])?.isInvalidated).toBe(true);
  });

  it('does not change the default when the server rejects the write', async () => {
    api(); const { user } = renderWithQuery(sessionView(<AddressesPage />));
    const change = await screen.findByRole('button', { name: 'Make Work default' }); failWrite = true; await user.click(change);
    await screen.findByText('Something went wrong. Please try again.');
    expect(screen.queryByText('Please try again.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Home Default' })).toBeTruthy();
  });

  it.each(unsafeErrors)('protects account reads from $name and allows curated 4xx copy', async (failure) => {
    let curated = false;
    mockApi(() => {
      if (curated) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'User not found' } } };
      if (failure.status === 0) throw new Error(rawError);
      return failure;
    });
    const { user } = renderWithQuery(sessionView(<AccountPage />));
    await screen.findByText(genericError);
    expect(screen.queryByText(rawError)).toBeNull();
    curated = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('User not found');
    expect(screen.queryByText(genericError)).toBeNull();
  });

  it.each(unsafeErrors)('protects account writes from $name and allows curated 4xx copy', async (failure) => {
    let curated = false;
    const normal = api();
    mockApi((request) => {
      if (request.method === 'PUT') {
        if (curated) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Address not found' } } };
        if (failure.status === 0) throw new Error(rawError);
        return failure;
      }
      return normal(request.url.toString(), request.init).then(async (response) => ({ status: response.status, body: await response.json() }));
    });
    const { user } = renderWithQuery(sessionView(<AddressesPage />));
    const button = await screen.findByRole('button', { name: 'Make Work default' });
    await user.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe(genericError);
    expect(screen.queryByText(rawError)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Home Default' })).toBeTruthy();
    curated = true;
    await user.click(button);
    expect((await screen.findByRole('alert')).textContent).toBe('Address not found');
    expect(screen.queryByText(genericError)).toBeNull();
  });

  it('confirms deletion and renders the replacement default returned by the server', async () => {
    api(); const { user } = renderWithQuery(sessionView(<AddressesPage />));
    await user.click(await screen.findByRole('button', { name: 'Remove Home' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await screen.findByRole('heading', { name: 'Work Default' });
    expect(screen.queryByText('Test Street, Georgetown')).toBeNull();
    expect(calls.find((c) => c.method === 'DELETE')?.url.pathname).toBe('/api/v1/customer/addresses/home');
  });

  it('edits a saved address without sending isDefault or binding the cart', async () => {
    api(); const { user } = renderWithQuery(sessionView(<AddressesPage />));
    await user.click(await screen.findByRole('button', { name: 'Edit Home' }));
    await user.clear(screen.getByLabelText('Label')); await user.type(screen.getByLabelText('Label'), 'Updated Home');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    await screen.findByRole('heading', { name: 'Updated Home Default' });
    const call = calls.find((c) => c.method === 'PUT')!;
    expect(call.url.pathname).toBe('/api/v1/customer/addresses/home');
    expect(JSON.parse(String(call.init?.body))).toMatchObject({ label: 'Updated Home', latitude: 6.8, longitude: -58.1 });
    expect(JSON.parse(String(call.init?.body))).not.toHaveProperty('isDefault');
  });

  it('keeps saved values on immediate re-edit and save while address refreshes are slow', async () => {
    const refreshes: (() => void)[] = [];
    let reads = 0;
    const normal = api();
    mockApi((request) => {
      if (request.url.pathname === '/api/v1/customer/addresses' && request.method === 'GET' && ++reads > 1) {
        const snapshot = structuredClone(addresses);
        return new Promise((resolve) => { refreshes.push(() => resolve(ok(snapshot))); });
      }
      return normal(request.url.toString(), request.init).then(async (response) => ({ status: response.status, body: await response.json() }));
    });
    const { user } = renderWithQuery(sessionView(<AddressesPage />));
    await user.click(await screen.findByRole('button', { name: 'Edit Work' }));
    await user.clear(screen.getByLabelText('Label')); await user.type(screen.getByLabelText('Label'), 'Updated Work');
    await user.clear(screen.getByPlaceholderText('Search address…')); await user.type(screen.getByPlaceholderText('Search address…'), 'Mapped');
    await user.click(await screen.findByRole('button', { name: 'Mapped Test Street' }));
    await user.type(screen.getByLabelText('Delivery instructions (optional)'), 'First saved instructions');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(refreshes).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /Edit .*Work/ }));
    expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('Updated Work');
    expect((screen.getByPlaceholderText('Search address…') as HTMLInputElement).value).toBe('Mapped Test Street');
    expect((screen.getByLabelText('Delivery instructions (optional)') as HTMLInputElement).value).toBe('First saved instructions');
    await user.clear(screen.getByLabelText('Delivery instructions (optional)')); await user.type(screen.getByLabelText('Delivery instructions (optional)'), 'Second saved instructions');
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(refreshes).toHaveLength(2));
    const writes = calls.filter((call) => call.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes[1]!.url.pathname).toBe('/api/v1/customer/addresses/work');
    expect(JSON.parse(String(writes[1]!.init?.body))).toMatchObject({ label: 'Updated Work', addressLine1: 'Mapped Test Street', latitude: 6.81, longitude: -58.12, instructions: 'Second saved instructions' });
    await act(async () => { refreshes[1]!(); });
    await screen.findByText('Second saved instructions');
    await act(async () => { refreshes[0]!(); });
    await user.click(screen.getByRole('button', { name: 'Edit Updated Work' }));
    expect((screen.getByLabelText('Delivery instructions (optional)') as HTMLInputElement).value).toBe('Second saved instructions');
  });

  it('adds a mapped address as default without changing the phone-matched initial choice', async () => {
    api(); const { user } = renderWithQuery(sessionView(<AddressesPage />));
    await user.click(await screen.findByRole('button', { name: 'Add an address' }));
    expect((screen.getByRole('button', { name: 'Save address' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByPlaceholderText('Search address…'), 'Mapped');
    await user.click(await screen.findByRole('button', { name: 'Mapped Test Street' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Make this my default address' }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save address' }));
    await screen.findByText('Mapped Test Street, Georgetown');
    const body = JSON.parse(String(calls.find((c) => c.method === 'POST')?.init?.body));
    expect(body).toMatchObject({ latitude: 6.81, longitude: -58.12, addressLine1: 'Mapped Test Street', isDefault: true });
    expect(addresses.filter((a) => a.isDefault).map((a) => a.id)).toEqual(['new-address']);
  });

  it('invalidates the saved pin when the city changes', async () => {
    api(); const { user } = renderWithQuery(sessionView(<AddressesPage />));
    await user.click(await screen.findByRole('button', { name: 'Edit Home' }));
    expect((screen.getByRole('button', { name: 'Save address' }) as HTMLButtonElement).disabled).toBe(false);
    await user.type(screen.getByLabelText('City / town'), ' changed');
    expect((screen.getByRole('button', { name: 'Save address' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('ignores an old place-details result after a city edit', async () => {
    let resolveDetails!: (_value: ReturnType<typeof ok>) => void;
    const normal = api();
    mockApi((request) => {
      if (request.url.pathname.endsWith('/places/autocomplete')) return ok([{ placeId: 'slow-place', primary: 'Old mapped street' }]);
      if (request.url.pathname.endsWith('/places/details')) return new Promise((resolve) => { resolveDetails = resolve; });
      return normal(request.url.toString(), request.init).then(async (response) => ({ status: response.status, body: await response.json() }));
    });
    const { user } = renderWithQuery(sessionView(<AddressesPage />));
    await user.click(await screen.findByRole('button', { name: 'Add an address' }));
    await user.type(screen.getByPlaceholderText('Search address…'), 'Old mapped');
    await user.click(await screen.findByRole('button', { name: 'Old mapped street' }));
    await user.type(screen.getByLabelText('City / town'), ' changed');
    await act(async () => { resolveDetails(ok({ lat: 6.8, lng: -58.1 })); });
    expect((screen.getByRole('button', { name: 'Save address' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByDisplayValue('Old mapped street')).toBeNull();
  });

  it.each([false, true])('checkout submits the new default while preserving an explicit cart address (%s)', async (explicit) => {
    const normal = api();
    const item = { id: 'item', name: 'Test item', isAvailable: true, fulfillment: 'DELIVERY' };
    const store = { id: 'store-1', slug: 'test-store', name: 'Test Store', isCurrentlyOpen: true, acceptingOrders: true, deliveryRadius: 8, categories: [{ id: 'category', items: [item] }] };
    const cart = () => ({
      items: [{ id: 'line', itemId: 'item', name: 'Test item', quantity: 1, customerPrice: 100, lineTotal: 100, fulfillment: 'DELIVERY', isAvailable: true }],
        deliveryAddress: explicit ? home : addresses.find((a) => a.isDefault), vendor: store,
        subtotalCustomer: 100, deliveryFee: 50, totalAmount: 150, tipAmount: 0, discount: 0, deliveryDistanceKm: 1,
        meetsMinimum: true, minimumOrderAmount: 0,
        paymentCapabilities: { scope: 'test-cart', cash: { available: true, fundsFlow: 'DIRECT_AT_HANDOVER' }, mmg: { available: false, unavailableReason: 'VENDOR_NOT_CONFIGURED' } },
    });
    mockApi((request) => {
      const path = request.url.pathname;
      if (path === '/api/v1/customer/cart') return ok(cart());
      if (path === '/api/v1/public/storefronts/test-store' || path === '/api/v1/customer/vendors/store-1') return ok(store);
      if (path === '/api/v1/customer/cart/address') { calls.push(request); return ok({ cart: cart() }); }
      if (path === '/api/v1/customer/checkout') { calls.push(request); return ok({ order: { id: 'test-order' }, orders: [{ id: 'test-order' }] }); }
      return normal(request.url.toString(), request.init).then(async (response) => ({ status: response.status, body: await response.json() }));
    });
    const view = renderWithQuery(sessionView(<AddressesPage />));
    await view.user.click(await screen.findByRole('button', { name: 'Make Work default' }));
    await screen.findByRole('heading', { name: 'Work Default' });
    view.rerender(sessionView(<CartPage />));
    const place = await screen.findByRole('button', { name: 'Place cash order · $150' });
    await waitFor(() => expect((place as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('Saved delivery address') as HTMLSelectElement).value).toBe(explicit ? 'home' : 'work');
    await view.user.click(place);
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/checkout'))).toBe(true));
    const addressCall = calls.find((c) => c.url.pathname.endsWith('/cart/address'))!;
    expect(JSON.parse(String(addressCall.init?.body))).toEqual({ addressId: explicit ? 'home' : 'work' });
  });

  it('ignores a failed old place lookup after selecting a newer street', async () => {
    let rejectOld!: (_reason: Error) => void;
    const normal = api();
    mockApi((request) => {
      if (request.url.pathname.endsWith('/places/autocomplete')) return ok(request.url.searchParams.get('q') === 'Old' ? [{ placeId: 'slow-place', primary: 'Old street' }] : [{ placeId: 'new-place', primary: 'New street', lat: 6.81, lng: -58.12 }]);
      if (request.url.pathname.endsWith('/places/details')) return new Promise((_resolve, reject) => { rejectOld = reject; });
      return normal(request.url.toString(), request.init).then(async (response) => ({ status: response.status, body: await response.json() }));
    });
    const { user } = renderWithQuery(sessionView(<AddressesPage />));
    await user.click(await screen.findByRole('button', { name: 'Add an address' }));
    const street = screen.getByPlaceholderText('Search address…');
    await user.type(street, 'Old'); await user.click(await screen.findByRole('button', { name: 'Old street' }));
    await user.clear(street); await user.type(street, 'New'); await user.click(await screen.findByRole('button', { name: 'New street' }));
    await act(async () => { rejectOld(new Error('Old lookup failed')); });
    expect((screen.getByPlaceholderText('Search address…') as HTMLInputElement).value).toBe('New street');
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save address' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('submits an order support ticket and shows its status using the phone contract', async () => {
    api(); const { user } = renderWithQuery(sessionView(await HelpPage({ searchParams: Promise.resolve({ orderId: 'order-1' }) })));
    await screen.findByText('No requests yet.');
    expect((screen.getByLabelText('Topic') as HTMLSelectElement).value).toBe('ORDER_ISSUE');
    await user.type(screen.getByLabelText('Short summary'), 'Missing item');
    await user.type(screen.getByLabelText('What happened?'), 'One item was missing.');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByRole('heading', { name: 'Missing item' });
    expect(screen.getByText('Open')).toBeTruthy();
    expect(JSON.parse(String(calls.find((c) => c.method === 'POST')?.init?.body))).toEqual({ category: 'ORDER_ISSUE', orderId: 'order-1', subject: 'Missing item', message: 'One item was missing.' });
    expect(screen.getByRole('link', { name: 'Email support' }).getAttribute('href')).toBe('mailto:support@swiftgy.com');
    expect(screen.getByRole('link', { name: 'Frequently asked questions' }).getAttribute('href')).toBe('/faq');
  });

  it('provides app-only SOS guidance and no web emergency button', () => {
    api(); renderWithQuery(sessionView(<SafetyPage />));
    expect(screen.getByText(/Use the Swift app for SOS/)).toBeTruthy();
    expect(screen.getByText(/Support requests are not emergency alerts/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /SOS/ })).toBeNull(); expect(calls).toHaveLength(0);
  });

  it('removes the previous person’s address draft on account change', async () => {
    api(); const view = renderWithQuery(sessionView(<AddressesPage />));
    await view.user.click(await screen.findByRole('button', { name: 'Edit Home' }));
    fireEvent.change(screen.getByLabelText('Delivery instructions (optional)'), { target: { value: 'Private draft' } });
    addresses = [];
    act(() => { adoptSession('second-test-customer'); view.rerender(sessionView(<AddressesPage />, { ...signedIn, scope: 'second-test-customer', epoch: 1 })); });
    expect(screen.queryByDisplayValue('Private draft')).toBeNull();
    await screen.findByText('No addresses yet. Add where deliveries should go.');
    expect(screen.queryByText('Test Street, Georgetown')).toBeNull();
  });
  it('never renders a previous account’s late profile response', async () => {
    let resolveOld!: (_value: ReturnType<typeof ok>) => void;
    let reads = 0;
    mockApi(({ url }) => {
      if (url.pathname !== '/api/v1/customer/profile') throw new Error('Unexpected profile endpoint');
      reads += 1;
      if (reads === 1) return new Promise((resolve) => { resolveOld = resolve; });
      return ok({ ...profile, id: 'second-test-customer', firstName: 'Second' });
    });
    const view = renderWithQuery(sessionView(<AccountPage />));
    await waitFor(() => expect(reads).toBe(1));
    act(() => { adoptSession('second-test-customer'); view.rerender(sessionView(<AccountPage />, { ...signedIn, scope: 'second-test-customer', epoch: 1 })); });
    await screen.findByText('Second Customer');
    await act(async () => { resolveOld(ok({ ...profile, firstName: 'Previous' })); });
    expect(screen.queryByText('Previous Customer')).toBeNull();
    expect(screen.getByText('Second Customer')).toBeTruthy();
  });

});
