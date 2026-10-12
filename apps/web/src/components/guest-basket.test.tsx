import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CustomerSessionProvider } from './customer-session';
import { GuestBasketSync, GuestCart } from './guest-basket';
import { addGuestLine, prepareGuestMerge, readGuestBasket } from '@/lib/basket';
import * as auth from '@/lib/auth';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });
it('binds a basket upload to the newly restored account rather than the stale guest render', async () => {
  addGuestLine({ vendorId: 'fixture-vendor', storeSlug: 'fixture-menu', vendorName: 'Fixture Menu', itemId: 'fixture-item', name: 'Soup', quantity: 1, unitPrice: 800, selectedOptions: {} });
  const principal = vi.spyOn(auth, 'getSessionPrincipal').mockReturnValue(null);
  const ensureSignedIn = vi.fn(async () => { principal.mockReturnValue('restored-customer'); return true; });
  const fetch = vi.spyOn(auth, 'apiFetch').mockRejectedValue(new Error('connection lost'));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CustomerSessionProvider value={{ status: 'guest', scope: 'guest', epoch: 0, ensureSignedIn, nearPoint: null, setNearPoint: () => undefined }}><GuestCart /></CustomerSessionProvider>
  </QueryClientProvider>);
  await screen.findByText('Soup'); expect(ensureSignedIn).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Place order' }));
  await waitFor(() => expect(readGuestBasket().pending).toBeTruthy());
  expect(readGuestBasket().pending?.scope).toBe('restored-customer');
  expect(ensureSignedIn).toHaveBeenCalledTimes(1); expect(readGuestBasket().lines).toHaveLength(1);
});

it('discards a late merge response from the old account and resumes upload for the current account', async () => {
  addGuestLine({ vendorId: 'fixture-vendor', storeSlug: 'fixture-menu', vendorName: 'Fixture Menu', itemId: 'fixture-item', name: 'Soup', quantity: 1, unitPrice: 800, selectedOptions: {} });
  let finish: (_value: unknown) => void = () => undefined;
  const first = new Promise(resolve => { finish = resolve; });
  let finishCurrent: (_value: unknown) => void = () => undefined;
  const current = new Promise(resolve => { finishCurrent = resolve; });
  const fetch = vi.spyOn(auth, 'apiFetch').mockReturnValueOnce(first as never).mockReturnValueOnce(current as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (scope: string) => <QueryClientProvider client={client}><CustomerSessionProvider value={{ status: 'signed-in', scope, epoch: scope === 'account-a' ? 1 : 2, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined }}><GuestBasketSync /></CustomerSessionProvider></QueryClientProvider>;
  const mounted = render(view('account-a')); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const line = readGuestBasket().lines[0]!;
  mounted.rerender(view('account-b'));
  await act(async () => { finish({ data: { applied: false, verdicts: [{ clientLineId: line.clientLineId, status: 'DIFFERENT_STORE' }], cart: { items: [] } } }); });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Your basket needs a check')).toBeNull();
  await act(async () => { finishCurrent({ data: { applied: true, verdicts: [{ clientLineId: line.clientLineId, status: 'ADDED' }], cart: { items: [] } } }); });
  await waitFor(() => expect(readGuestBasket().lines).toEqual([]));
  expect(screen.queryByText('Your basket needs a check')).toBeNull();
});

it('never renders a known basket verdict under a different account while its upload is pending', async () => {
  addGuestLine({ vendorId: 'fixture-vendor', storeSlug: 'fixture-menu', vendorName: 'Fixture Menu', itemId: 'fixture-item', name: 'Soup', quantity: 1, unitPrice: 800, selectedOptions: {} });
  const line = readGuestBasket().lines[0]!;
  let finish: (_value: unknown) => void = () => undefined;
  const pending = new Promise(resolve => { finish = resolve; });
  const fetch = vi.spyOn(auth, 'apiFetch').mockResolvedValueOnce({ data: { applied: false, verdicts: [{ clientLineId: line.clientLineId, status: 'DIFFERENT_STORE' }], cart: { items: [] } } } as never).mockReturnValueOnce(pending as never);
  const client = new QueryClient();
  const view = (scope: string) => <QueryClientProvider client={client}><CustomerSessionProvider value={{ status: 'signed-in', scope, epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined }}><GuestBasketSync /></CustomerSessionProvider></QueryClientProvider>;
  const mounted = render(view('account-a')); await screen.findByText('Your basket needs a check');
  mounted.rerender(view('account-b')); await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('Your basket needs a check')).toBeNull();
  await act(async () => { finish({ data: { applied: true, verdicts: [{ clientLineId: line.clientLineId, status: 'ADDED' }], cart: { items: [] } } }); });
});

it('keeps an unknown changed price as an unknown figure and prevents accepting it', async () => {
  addGuestLine({ vendorId: 'fixture-vendor', storeSlug: 'fixture-menu', vendorName: 'Fixture Menu', itemId: 'fixture-item', name: 'Soup', quantity: 1, unitPrice: 800, selectedOptions: {} });
  const line = readGuestBasket().lines[0]!;
  vi.spyOn(auth, 'apiFetch').mockResolvedValue({ data: { applied: false, verdicts: [{ clientLineId: line.clientLineId, status: 'PRICE_CHANGED' }], cart: { items: [] } } } as never);
  render(<QueryClientProvider client={new QueryClient()}><CustomerSessionProvider value={{ status: 'signed-in', scope: 'account-a', epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined }}><GuestBasketSync /></CustomerSessionProvider></QueryClientProvider>);
  await screen.findByText('Your basket needs a check');
  expect(screen.getByText(/now —/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Accept current item prices' }) as HTMLButtonElement).disabled).toBe(true);
  expect(readGuestBasket().lines[0]?.unitPrice).toBe(800);
});

// [#1594 review S3] A basket frozen mid-upload must never lock a person out of
// /cart and /checkout. Discarding the browser copy is safe: the server's
// upload receipt is the record, and a committed upload is already in that
// account's saved cart.
const fixtureLine = { vendorId: 'fixture-vendor', storeSlug: 'fixture-menu', vendorName: 'Fixture Menu', itemId: 'fixture-item', name: 'Soup', quantity: 1, unitPrice: 800, selectedOptions: {} };
const signedInAs = (scope: string, node: React.ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <CustomerSessionProvider value={{ status: 'signed-in', scope, epoch: 0, ensureSignedIn: async () => true, nearPoint: null, setNearPoint: () => undefined }}>{node}</CustomerSessionProvider>
</QueryClientProvider>;

it('another account on this browser can discard a basket frozen mid-upload, after confirming, and sends nothing', async () => {
  addGuestLine(fixtureLine); prepareGuestMerge('account-a');
  vi.spyOn(auth, 'getSessionPrincipal').mockReturnValue('account-b');
  const fetch = vi.spyOn(auth, 'apiFetch');
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal('confirm', confirm);
  render(signedInAs('account-b', <GuestCart />));
  fireEvent.click(await screen.findByRole('button', { name: 'Place order' }));
  expect(await screen.findByText(/belongs to another account/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Discard this browser basket' }));
  expect(readGuestBasket().lines).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Discard this browser basket' }));
  await screen.findByText(/Your basket is empty/);
  expect(readGuestBasket()).toEqual({ version: 1, lines: [] });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
});

it('offers the same way out when the upload keeps failing on the server', async () => {
  addGuestLine(fixtureLine);
  vi.spyOn(auth, 'apiFetch').mockRejectedValue(new Error('Swift is having trouble right now.'));
  vi.stubGlobal('confirm', vi.fn(() => true));
  render(signedInAs('account-a', <GuestBasketSync />));
  expect(await screen.findByText('Swift is having trouble right now.')).toBeTruthy();
  expect(readGuestBasket().pending?.scope).toBe('account-a');
  fireEvent.click(screen.getByRole('button', { name: 'Discard this browser basket' }));
  await waitFor(() => expect(screen.queryByText('Your basket needs a check')).toBeNull());
  expect(readGuestBasket()).toEqual({ version: 1, lines: [] });
});
