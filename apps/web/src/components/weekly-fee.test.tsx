import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { mockApi, renderWithQuery } from '@/test/test-utils';
import { apiFetch, setSelectedStore } from '@/lib/auth';

describe('rendered weekly fee', () => {
  it('opens new and handed-back OPEN checkouts in the same tab with a fresh key per tap', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const keys: string[] = [];
    const posts: string[] = [];
    mockApi(({ method, url, init }) => {
      if (method === 'POST') {
        keys.push(new Headers(init?.headers).get('Idempotency-Key')!); posts.push(url.pathname);
        return { status: keys.length === 1 ? 201 : 200, body: { success: true, data: { ref: 'open-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/opaque', amountGyd: 1200, currencyCode: 'GYD' } } };
      }
      if (url.pathname.endsWith('/open-ref')) return { body: { success: true, data: { ref: 'open-ref', status: 'OPEN', amountGyd: 1200, subscriptionStatus: 'ACTIVE' } } };
      return { body: { success: true, data: { status: 'ACTIVE', amountDueGyd: 1200, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }], latestMmgCheckout: keys.length ? { ref: 'open-ref', status: 'OPEN', expiresAt: '2099-01-01T12:00:00Z' } : null, reopenableMmgCheckout: keys.length ? { ref: 'open-ref', expiresAt: '2099-01-01T12:00:00Z' } : null } } };
    });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 with MMG' }));
    await screen.findByText('Waiting for MMG…');
    await act(async () => { await view.queryClient.invalidateQueries({ queryKey: ['weekly-fee'] }); });
    await view.user.click(await screen.findByRole('button', { name: "Back to MMG's page" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(assign).toHaveBeenCalledWith('https://checkout.test/opaque');
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    expect(posts).toEqual(['/api/v1/vendor/subscription/mmg-checkout', '/api/v1/vendor/subscription/mmg-checkout/open-ref/reopen']);
    expect(document.body.textContent).not.toContain('Paid:'); view.unmount();
  });
  it.each(['live', 'off', 'absent'])('MMG %s controls the actual button; deprecated fields cannot render', async (state) => {
    mockApi(() => ({ body: { success: true, data: { status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-06T12:00:00Z', payActions: state === 'absent' ? undefined : [{ id: 'MMG_CHECKOUT', state, amountGyd: 1200, currencyCode: 'GYD' }, { id: 'CARD', state: 'off' }], sanFormatted: 'private-number', payCashSteps: ['Go to MMG agent'], activationCopy: 'instant restoration' } } }));
    const view = renderWithQuery(<WeeklyFee family="vendor" />); await screen.findByText('Nothing due right now: your next bill is 6 Oct 2026');
    const button = screen.queryByRole('button', { name: 'Pay GY$1,200 with MMG' });
    if (state === 'live') expect(button).toBeTruthy(); else expect(button).toBeNull();
    expect(document.body.textContent).not.toMatch(/coming soon|private-number|MMG agent|instant restoration|card/i); view.unmount();
  });
  it.each(['vendor', 'rider', 'driver'] as const)('%s sends platform and new idempotency keys; 409 follows the ref and hides Pay', async (family) => {
    setSelectedStore('store-checkout');
    const calls = mockApi(({ method, url, init }) => {
      expect(new Headers(init?.headers).get('x-client-platform')).toBe('web');
      expect(new Headers(init?.headers).get('x-swift-client')).toBe('web');
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
      expect(init?.credentials).toBe('include');
      if (family === 'vendor') expect(new Headers(init?.headers).get('x-vendor-id')).toBe('store-checkout');
      if (method === 'POST') {
        expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{8,128}$/); expect(init?.body).toBe('{}');
        return { status: 409, body: { success: false, error: { code: 'CHECKOUT_CONFIRMING', details: { ref: 'earlier-ref' } } } };
      }
      if (url.pathname.endsWith('/earlier-ref')) return { body: { success: true, data: { ref: 'earlier-ref', status: 'CONFIRMING', amountGyd: 1200, currencyCode: 'GYD', subscriptionStatus: 'PAST_DUE' } } };
      return { body: { success: true, data: { status: 'PAST_DUE', amountDueGyd: 1200, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] } } };
    });
    const view = renderWithQuery(<WeeklyFee family={family} />); await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 with MMG' }));
    await screen.findByText("Confirming your payment with MMG. Don't pay again.");
    expect(screen.queryByRole('button', { name: /Pay GY/ })).toBeNull();
    await waitFor(() => expect(calls.mock.calls.some(([url]) => String(url).endsWith(`/${family}/subscription/mmg-checkout/earlier-ref`))).toBe(true)); view.unmount();
  });
  it.each(['subscription refresh', 'tab focus'])('EXPIRED becomes Paid from fresh server state on %s', async (trigger) => {
    let status = 'EXPIRED';
    const checkout = () => ({ ref: 'late-ref', status, amountGyd: 1200, currencyCode: 'GYD', subscriptionStatus: 'ACTIVE', confirmedAt: status === 'CONFIRMED' ? '2026-09-29T12:00:00Z' : null });
    mockApi(({ url }) => url.pathname.endsWith('/late-ref')
      ? { body: { success: true, data: checkout() } }
      : { body: { success: true, data: { status: 'ACTIVE', amountDueGyd: 0, latestMmgCheckout: checkout(), recentCheckouts: [checkout()] } } });
    const view = renderWithQuery(<WeeklyFee family="rider" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('expired'));
    status = 'CONFIRMED';
    if (trigger === 'subscription refresh') await act(async () => { await view.queryClient.invalidateQueries({ queryKey: ['weekly-fee'] }); });
    else act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Paid: GY$1,200'));
    expect(document.body.textContent).not.toContain('This checkout expired');
    view.unmount();
  });

  it.each(['storage then focus', 'focus before storage', 'storage only'])('two tabs: %s never sends A’s ref with B’s header or retains A’s Paid', async (order) => {
    setSelectedStore('store-A');
    const checkout = { ref: 'ref-A', status: 'CONFIRMED', amountGyd: 1200, currencyCode: 'GYD', subscriptionStatus: 'ACTIVE', confirmedAt: '2026-09-29T12:00:00Z' };
    const calls: Array<[string, string | null]> = [];
    mockApi(({ url, init }) => {
      const store = new Headers(init?.headers).get('x-vendor-id');
      calls.push([url.pathname, store]);
      return { body: { success: true, data: url.pathname.endsWith('/ref-A') ? checkout : store === 'store-A'
        ? { status: 'ACTIVE', amountDueGyd: 0, latestMmgCheckout: checkout }
        : { status: 'ACTIVE', amountDueGyd: 3400, latestMmgCheckout: null, recentCheckouts: [], payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 3400, currencyCode: 'GYD' }] } } };
    });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Paid: GY$1,200'));
    calls.length = 0;
    // Tab 2 updates their shared storage. Tab 1 has not rendered yet.
    localStorage.setItem('swift_web_store', 'store-B');
    const storage = () => window.dispatchEvent(new StorageEvent('storage', { key: 'swift_web_store', oldValue: 'store-A', newValue: 'store-B', storageArea: localStorage }));
    act(() => {
      if (order !== 'focus before storage') storage();
      if (order !== 'storage only') window.dispatchEvent(new Event('focus'));
    });
    await screen.findByText('GY$3,400 due now');
    if (order === 'focus before storage') act(storage);
    expect(calls.some(([url, store]) => url.endsWith('/ref-A') && store === 'store-B')).toBe(false);
    expect(document.body.textContent).not.toContain('Paid:');
    expect(screen.queryByRole('status')).toBeNull();
    view.unmount();
  });

  it("each recent checkout shows the Swift reference, and MMG's transaction ID only once confirmed", async () => {
    const base = { amountGyd: 2100, currencyCode: 'GYD', createdAt: '2026-10-01T19:38:19Z', expiresAt: '2026-10-01T20:08:19Z', subscriptionStatus: 'ACTIVE' };
    const recentCheckouts = [
      { ...base, ref: 'paid-ref', status: 'CONFIRMED', confirmedAt: '2026-10-01T19:39:42Z', swiftReference: '175933829900012345', mmgTransactionId: '20402048536279' },
      // A held payment never shows an MMG id, even if one were sent.
      { ...base, ref: 'held-ref', status: 'HELD', confirmedAt: null, swiftReference: '175933840000054321', mmgTransactionId: '20402048599999' },
      // An older API sends neither: nothing is invented.
      { ...base, ref: 'old-ref', status: 'NOT_PAID', confirmedAt: null },
    ];
    mockApi(() => ({ body: { success: true, data: { status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-06T12:00:00Z', recentCheckouts } } }));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await screen.findByText('Recent checkouts');
    await screen.findByText('175933829900012345');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Swift reference: 175933829900012345');
    expect(text).toContain('MMG transaction ID: 20402048536279');
    expect(text).toContain('Swift reference: 175933840000054321');
    expect(text).not.toContain('20402048599999');
    expect(text.match(/Swift reference:/g)).toHaveLength(2);
    expect(text.match(/MMG transaction ID:/g)).toHaveLength(1);
    expect(text).toContain("We're checking this payment by hand. Don't pay again. Support will contact you.");
    view.unmount();
  });

  it.each(['subscription', 'subscription/mmg-checkout/ref-A', 'subscription/mmg-checkout'])('refuses stale captured context before sending %s', async (path) => {
    setSelectedStore('store-A');
    const policy = { storeId: 'store-A' };
    localStorage.setItem('swift_web_store', 'store-B');
    const fetch = mockApi(() => ({ body: { success: true, data: {} } }));
    await expect(apiFetch(`/api/v1/vendor/${path}`, path.endsWith('mmg-checkout') ? { method: 'POST', body: '{}' } : undefined, policy)).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses the original store request when another tab switches during a 401 refresh', async () => {
    setSelectedStore('store-A');
    let finishRefresh!: () => void;
    const calls = mockApi(async ({ url }) => {
      if (url.pathname.endsWith('/auth/refresh')) {
        await new Promise<void>((resolve) => { finishRefresh = resolve; });
        return { body: { success: true } };
      }
      return { status: 401, body: {} };
    });
    const request = apiFetch('/api/v1/vendor/subscription/mmg-checkout/ref-A', undefined, { storeId: 'store-A' });
    const rejected = expect(request).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    await waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    localStorage.setItem('swift_web_store', 'store-B');
    finishRefresh();
    await rejected;
    expect(calls).toHaveBeenCalledTimes(2); // one read + refresh; no retry
  });

});


describe('own checkout reopen affordance', () => {
  it('reload with MMG off shows Back and Guyana deadline; same page and fresh keys on two taps', async () => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const expiresAt = '2099-10-08T23:30:00Z';
    const c = { ref: 'own-open', status: 'OPEN', expiresAt, amountGyd: 1200, currencyCode: 'GYD', subscriptionStatus: 'ACTIVE' };
    const keys: string[] = [];
    const posts: string[] = [];
    mockApi(({ method, url, init }) => {
      if (method === 'POST') { keys.push(new Headers(init?.headers).get('Idempotency-Key')!); posts.push(url.pathname); return { status: 200, body: { success: true, data: { ...c, checkoutUrl: 'https://checkout.test/same-page' } } }; }
      return { body: { success: true, data: url.pathname.endsWith('/own-open') ? c : { status: 'ACTIVE', amountDueGyd: 1200, payActions: [{ id: 'MMG_CHECKOUT', state: 'off' }], latestMmgCheckout: c, reopenableMmgCheckout: { ref: c.ref, expiresAt } } } };
    });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    const back = await screen.findByRole('button', { name: "Back to MMG's page" });
    expect(document.body.textContent).toContain('Swift keeps this checkout open until 19:30 (Guyana time).');
    expect(document.body.textContent).toContain("Already paid on MMG's page? Don't pay again — we'll confirm it with MMG.");
    expect(screen.queryByRole('button', { name: /Pay GY/ })).toBeNull();
    await view.user.click(back); await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    await view.user.click(await screen.findByRole('button', { name: "Back to MMG's page" }));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    expect(posts).toEqual(['/api/v1/vendor/subscription/mmg-checkout/own-open/reopen', '/api/v1/vendor/subscription/mmg-checkout/own-open/reopen']);
    expect(assign).toHaveBeenCalledWith('https://checkout.test/same-page'); view.unmount();
  });
  it.each(['OPEN', 'EXPIRED', 'CONFIRMING', 'HELD'])('%s without a reopen grant has no Pay or Back, even with a stale live action', async (status) => {
    const c = { ref: 'blocked-ref', status, expiresAt: '2099-01-01T12:00:00Z', amountGyd: 1200, subscriptionStatus: 'ACTIVE' };
    mockApi(({ url }) => ({ body: { success: true, data: url.pathname.endsWith('/blocked-ref') ? c : { status: 'ACTIVE', latestMmgCheckout: c, reopenableMmgCheckout: null, payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] } } }));
    const view = renderWithQuery(<WeeklyFee family="rider" />); await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: /Pay GY|Back to MMG|Retry/ })).toBeNull();
    if (status === 'EXPIRED') expect(document.body.textContent).toContain('Swift support will check this payment.'); view.unmount();
  });
});


describe('[review F1] a stale Back tap on the web', () => {
  it.each([
    ['the server refuses it (paid on another device)', { status: 409, body: { success: false, error: { code: 'CHECKOUT_NOT_REOPENABLE', message: 'no', details: { ref: 'own-open', status: 'CONFIRMED' } } } }],
    ['the server answers with another checkout', { status: 200, body: { success: true, data: { ref: 'other-ref', status: 'OPEN', checkoutUrl: 'https://checkout.test/other-page', amountGyd: 1200, currencyCode: 'GYD' } } }],
  ] as const)('opens no MMG page when %s, and refreshes the fee', async (_case, answer) => {
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const c = { ref: 'own-open', status: 'OPEN', expiresAt: '2099-10-08T23:30:00Z', amountGyd: 1200, currencyCode: 'GYD', subscriptionStatus: 'ACTIVE' };
    let feeReads = 0; const reads: string[] = [];
    mockApi(({ method, url }) => {
      if (method === 'POST') return answer;
      if (url.pathname.includes('/mmg-checkout/')) { reads.push(url.pathname); return { body: { success: true, data: c } }; }
      feeReads += 1;
      return { body: { success: true, data: { status: 'ACTIVE', amountDueGyd: 1200, payActions: [{ id: 'MMG_CHECKOUT', state: 'off' }], latestMmgCheckout: c, reopenableMmgCheckout: { ref: c.ref, expiresAt: c.expiresAt } } } };
    });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    const back = await screen.findByRole('button', { name: "Back to MMG's page" });
    const before = feeReads;
    await view.user.click(back);
    await waitFor(() => expect(feeReads).toBeGreaterThan(before));
    await screen.findByText("We couldn't reopen that MMG page. Its latest status is shown here.");
    expect(assign).not.toHaveBeenCalled();
    expect(reads.every((path) => path.endsWith('/own-open'))).toBe(true); view.unmount();
  });
});
