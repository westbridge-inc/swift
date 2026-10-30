import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';
import { storeKey } from '@/lib/store-scope';
import PayAllBranchesPage from './page';
import WeeklyFeePage from '../page';

// ---------------------------------------------------------------------------
// [ENTERPRISE E1b · owner 29 Oct 2026] "Pay all my branches" on the web dashboard (MMG-CHECKOUT-API.md section 12):
// the owner sees each branch with what its own Pay would charge, the server's total, and ONE MMG checkout after
// "Confirm it's you"; the page follows it like the one-branch page does. A manager or staff member is never offered
// it, and nothing is asked of the server for them. Synthetic branches only.
// ---------------------------------------------------------------------------

const STORES = [{ id: 'store-1', name: 'North' }, { id: 'store-2', name: 'Camp' }];
const fees = (over: Record<string, unknown> = {}) => ({
  branches: [
    { vendorId: 'store-1', branchName: 'North', subscriptionId: 's1', subscriptionStatus: 'ACTIVE', state: 'DUE', amountGyd: 12000 },
    { vendorId: 'store-2', branchName: 'Camp', subscriptionId: 's2', subscriptionStatus: 'PAST_DUE', state: 'DUE', amountGyd: 9000 },
    { vendorId: 'store-3', branchName: 'East', subscriptionId: 's3', subscriptionStatus: 'ACTIVE', state: 'NOTHING_DUE', amountGyd: null },
  ],
  totalGyd: 21000, currencyCode: 'GYD', payable: true, recentCheckouts: [], ...over,
});
const chainCheckout = (status: string, over: Record<string, unknown> = {}) => ({
  ref: 'chain-ref', status, amountGyd: 21000, currencyCode: 'GYD', createdAt: '2026-10-30T12:00:00Z', expiresAt: '2099-01-01T00:00:00Z',
  confirmedAt: status === 'CONFIRMED' ? '2026-10-30T12:05:00Z' : null, swiftReference: '123456789012345678', mmgTransactionId: status === 'CONFIRMED' ? 'MMG-9' : null,
  branches: [{ vendorId: 'store-1', branchName: 'North', subscriptionId: 's1', amountGyd: 12000 }, { vendorId: 'store-2', branchName: 'Camp', subscriptionId: 's2', amountGyd: 9000 }],
  ...over,
});
const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } });

/** The console's role read (GET /vendor/stores), then the given handler. */
function api(myRole: string, handler: (_r: ApiRequest) => { status?: number; body: unknown } | undefined, stores = STORES) {
  return mockApi((r) => {
    if (r.url.pathname === '/api/v1/vendor/stores') return ok({ stores, selectedId: 'store-1', myRole });
    return handler(r) ?? { status: 404, body: { success: false, error: { code: 'NOT_FOUND' } } };
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('[E1b] the pay-all page', () => {
  beforeEach(() => { setSelectedStore('store-1'); });
  it('the owner sees each branch, the server\'s total, and pays it in one MMG checkout with the list as shown', async () => {
    setSelectedStore('store-1');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const posts: Array<{ body: unknown; key: string | null; platform: string | null; store: string | null }> = [];
    api('OWNER', ({ method, url, init }) => {
      if (url.pathname === '/api/v1/vendor/subscription/chain-fees') return ok(fees());
      if (method === 'POST' && url.pathname === '/api/v1/vendor/subscription/chain-fees/mmg-checkout') {
        const h = new Headers(init?.headers);
        posts.push({ body: JSON.parse(String(init?.body)), key: h.get('Idempotency-Key'), platform: h.get('x-client-platform'), store: h.get('x-vendor-id') });
        return ok({ ref: 'chain-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/page', amountGyd: 21000, currencyCode: 'GYD', expiresAt: '2099-01-01T00:00:00Z', branches: [] }, 201);
      }
      if (url.pathname === '/api/v1/vendor/subscription/chain-fees/mmg-checkout/chain-ref') return ok(chainCheckout('OPEN'));
      return undefined;
    });
    const view = renderWithQuery(<PayAllBranchesPage />);
    const list = await screen.findByRole('list', { name: 'Your branches' });
    expect(list.textContent).toContain('North');
    expect(list.textContent).toContain('GY$12,000');
    expect(list.textContent).toContain('Not charged: nothing due right now');
    expect(screen.getByTestId('pay-all-total').textContent).toBe('Total due: GY$21,000 for 2 branches');
    // Words true to behaviour: optional, a branch with nothing due is not charged, nothing is paid until MMG confirms.
    expect(document.body.textContent).toContain('This is optional. Each branch can still pay its own fee on its own Weekly fee page.');
    expect(document.body.textContent).toContain('is not in this payment and is not charged.');
    expect(document.body.textContent).toContain('Nothing is marked paid until MMG confirms the payment.');
    await view.user.click(screen.getByRole('button', { name: 'Pay GY$21,000 with MMG' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.test/page'));
    expect(posts).toEqual([{ body: { branches: [{ subscriptionId: 's1', amountGyd: 12000 }, { subscriptionId: 's2', amountGyd: 9000 }], totalGyd: 21000 }, key: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/), platform: 'web', store: 'store-1' }]);
    await screen.findByText('Waiting for MMG…');
    expect(document.body.textContent).not.toContain('Paid:');
    view.unmount();
  });

  it('asks "Confirm it\'s you" when the server wants it, then sends the same payment once more with the same key', async () => {
    vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const keys: Array<string | null> = [];
    let verified = false;
    api('OWNER', ({ method, url, init }) => {
      if (url.pathname === '/api/v1/vendor/subscription/chain-fees') return ok(fees());
      if (url.pathname === '/api/v1/auth/step-up') return ok({ sentTo: '+592 ••• ••12' });
      if (url.pathname === '/api/v1/auth/step-up/verify') { verified = true; return ok({}); }
      if (method === 'POST' && url.pathname.endsWith('/chain-fees/mmg-checkout')) {
        keys.push(new Headers(init?.headers).get('Idempotency-Key'));
        if (!verified) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED', message: 'Confirm it is you.' } } };
        return ok({ ref: 'chain-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/page', amountGyd: 21000, currencyCode: 'GYD', expiresAt: '2099-01-01T00:00:00Z' }, 201);
      }
      if (url.pathname.endsWith('/mmg-checkout/chain-ref')) return ok(chainCheckout('OPEN'));
      return undefined;
    });
    const view = renderWithQuery(<PayAllBranchesPage />);
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$21,000 with MMG' }));
    await view.user.type(await screen.findByLabelText('Code'), '123456');
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
    await waitFor(() => expect(window.location.assign).toHaveBeenCalledWith('https://checkout.test/page'));
    view.unmount();
  });

  it('closing "Confirm it\'s you" opens nothing and shows no error', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    api('OWNER', ({ method, url }) => {
      if (url.pathname === '/api/v1/vendor/subscription/chain-fees') return ok(fees());
      if (url.pathname === '/api/v1/auth/step-up') return ok({});
      if (method === 'POST' && url.pathname.endsWith('/chain-fees/mmg-checkout')) return { status: 403, body: { success: false, error: { code: 'STEP_UP_REQUIRED' } } };
      return undefined;
    });
    const view = renderWithQuery(<PayAllBranchesPage />);
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$21,000 with MMG' }));
    await view.user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Code')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pay GY$21,000 with MMG' })).toBeTruthy();
    view.unmount();
  });

  it.each([
    ['OPEN', 'Finish paying on the MMG page.'],
    ['CONFIRMING', "Confirming your payment with MMG. Don't pay again."],
    ['HELD', "We're checking this payment by hand. Don't pay again. Support will contact you."],
    ['EXPIRED', "This checkout expired. Don't pay again. Swift support will check this payment."],
  ])('a pay-all that is %s keeps Pay away and says its branches are paused', async (status, words) => {
    api('OWNER', ({ url }) => {
      if (url.pathname === '/api/v1/vendor/subscription/chain-fees') return ok(fees({ recentCheckouts: [chainCheckout(status)] }));
      if (url.pathname.endsWith('/mmg-checkout/chain-ref')) return ok(chainCheckout(status));
      return undefined;
    });
    const view = renderWithQuery(<PayAllBranchesPage />);
    await waitFor(() => expect(screen.getAllByText(words).length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /^Pay GY/ })).toBeNull();
    expect(document.body.textContent).toContain("its branches can't be paid on their own, so no fee is paid twice.");
    view.unmount();
  });

  it('a confirmed pay-all shows each branch\'s share and both references; not-paid offers Pay again', async () => {
    let status = 'CONFIRMED';
    api('OWNER', ({ url }) => {
      if (url.pathname === '/api/v1/vendor/subscription/chain-fees') return ok(fees({ recentCheckouts: [chainCheckout(status)] }));
      if (url.pathname.endsWith('/mmg-checkout/chain-ref')) return ok(chainCheckout(status));
      return undefined;
    });
    const view = renderWithQuery(<PayAllBranchesPage />);
    await waitFor(() => expect(screen.getAllByText('Paid: GY$21,000 received on 30 Oct 2026 for 2 branches.').length).toBeGreaterThan(0));
    expect(document.body.textContent).toContain('North: GY$12,000');
    expect(document.body.textContent).toContain('Camp: GY$9,000');
    expect(document.body.textContent).toContain('Swift reference: 123456789012345678');
    expect(document.body.textContent).toContain('MMG transaction ID: MMG-9');
    view.unmount();
    status = 'NOT_PAID';
    const again = renderWithQuery(<PayAllBranchesPage />);
    await waitFor(() => expect(screen.getAllByText("MMG didn't complete this payment. You can try again.").length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Pay GY$21,000 with MMG' })).toBeTruthy();
    again.unmount();
  });

  it('changed fees: the list is read again and the owner is asked to check it; nothing is opened', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    let reads = 0;
    api('OWNER', ({ method, url }) => {
      if (url.pathname === '/api/v1/vendor/subscription/chain-fees') { reads++; return ok(fees()); }
      if (method === 'POST') return { status: 409, body: { success: false, error: { code: 'PAYMENT_QUOTE_CHANGED' } } };
      return undefined;
    });
    const view = renderWithQuery(<PayAllBranchesPage />);
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$21,000 with MMG' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The weekly fees changed. Check the list again, then pay.');
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(assign).not.toHaveBeenCalled();
    view.unmount();
  });

  it('nothing due, or an account that may not open MMG here: no Pay button at all', async () => {
    let body = fees({ branches: [fees().branches[2]], totalGyd: 0, payable: false });
    api('OWNER', ({ url }) => (url.pathname === '/api/v1/vendor/subscription/chain-fees' ? ok(body) : undefined));
    const view = renderWithQuery(<PayAllBranchesPage />);
    await screen.findByText('No branch has a weekly fee to pay with MMG right now.');
    expect(screen.queryByRole('button', { name: /^Pay GY/ })).toBeNull();
    view.unmount();
    body = fees({ payable: false });
    const demo = renderWithQuery(<PayAllBranchesPage />);
    await screen.findByText("Paying all branches with MMG isn't available for this account right now.");
    expect(screen.queryByRole('button', { name: /^Pay GY/ })).toBeNull();
    demo.unmount();
  });

  it.each(['MANAGER', 'STAFF'])('a %s is told only the owner pays all branches, and the fees are never asked for', async (role) => {
    const calls = api(role, () => ok(fees()));
    const view = renderWithQuery(<PayAllBranchesPage />);
    await screen.findByText('Only the business owner can pay all branches at once.');
    expect(screen.queryByRole('button', { name: /^Pay GY/ })).toBeNull();
    expect(calls.mock.calls.some(([u]) => String(u).includes('chain-fees'))).toBe(false);
    view.unmount();
  });
});

describe('[E1b] the weekly-fee page\'s door to it', () => {
  beforeEach(() => { setSelectedStore('store-1'); });
  const sub = { status: 'ACTIVE', amountDueGyd: 0, payActions: [] };
  it('an owner of several stores sees "Pay all my branches"', async () => {
    api('OWNER', ({ url }) => (url.pathname === '/api/v1/vendor/subscription' ? ok(sub) : undefined));
    const view = renderWithQuery(<WeeklyFeePage />);
    const link = await screen.findByRole('link', { name: 'Pay all my branches' });
    expect(link.getAttribute('href')).toBe('/dashboard/weekly-fee/pay-all');
    view.unmount();
  });

  it.each([
    ['a manager', 'MANAGER', STORES],
    ['staff', 'STAFF', STORES],
    ['an owner of one store', 'OWNER', STORES.slice(0, 1)],
  ])('%s never sees it', async (_who, role, stores) => {
    const calls = api(role, ({ url }) => (url.pathname === '/api/v1/vendor/subscription' ? ok(sub) : undefined), stores);
    const view = renderWithQuery(<WeeklyFeePage />);
    await screen.findByRole('heading', { name: 'Weekly fee' });
    // The role read has answered (and the page has drawn after it) before looking.
    await waitFor(() => expect(calls.mock.calls.some(([u]) => String(u).includes('/api/v1/vendor/stores'))).toBe(true));
    await waitFor(() => expect(view.queryClient.getQueryData(storeKey('store-1', 'my-role'))).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('link', { name: 'Pay all my branches' })).toBeNull();
    view.unmount();
  });
});
