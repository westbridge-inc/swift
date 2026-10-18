import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { API_ORIGIN, mockApi, renderWithQuery } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';

// [CARD embed] The bank's card page inside the weekly-fee page. Shown only when the build
// turned it on and the server's card page is on the API origin; otherwise the page opens in
// this tab, as before. Whatever the frame does or says, only the server's read of the session
// decides what the partner is told.
const MMG = { id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' };
const cardLive = () => ({ id: 'CARD', state: 'live', payNow: { amount: 1200, currencyCode: 'GYD' }, addCard: false, cardOnFile: null });
const subscription = { success: true, data: { status: 'PAST_DUE', amountDueGyd: 1200, payActions: [MMG, cardLive()], latestMmgCheckout: null, recentCheckouts: [] } };
const session = (status: string) => ({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status, expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', subscriptionStatus: 'PAST_DUE', testMode: false });
const PAGE = `${API_ORIGIN}/api/v1/billing/card/pay/ptz_0123456789abcdef01234567`;

let status = 'OPEN';
let hostedUrl = PAGE;
function api() {
  return mockApi((r) => {
    const path = r.url.pathname;
    if (path.endsWith('/subscription')) return { body: subscription };
    // The test API is plain http, so this is a test server's page (a card page is otherwise only ever https).
    if (path.endsWith('/card-sessions') && r.method === 'POST') return { status: 201, body: { success: true, data: { ...session('OPEN'), hostedUrl, testMode: true } } };
    if (path.endsWith('/card-sessions/card-session-1')) return { body: { success: true, data: session(status) } };
    return { status: 404, body: { success: false, error: { code: 'NOT_FOUND' } } };
  });
}
const frame = () => document.querySelector('iframe');
beforeEach(() => {
  status = 'OPEN'; hostedUrl = PAGE; setSelectedStore('store-card');
  // The test DOM never loads the framed page (no network in tests).
  (window as unknown as { happyDOM?: { settings: { disableIframePageLoading: boolean } } }).happyDOM!.settings.disableIframePageLoading = true;
});
afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); vi.unstubAllEnvs(); });

async function payByCard() {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  const calls = api();
  const view = renderWithQuery(<WeeklyFee family="vendor" />);
  await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 by card' }));
  return { assign, calls, view };
}

describe('switched off (every build today)', () => {
  it('opens the card page in this tab, exactly as before; no frame', async () => {
    const { assign, view } = await payByCard();
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith(PAGE));
    expect(frame()).toBeNull();
    view.unmount();
  });
});

describe('switched on', () => {
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_CARD_FRAME', '1'); });

  it('shows the server’s card page in a sandboxed frame inside the page, not in a new page', async () => {
    const { assign, view } = await payByCard();
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(assign).not.toHaveBeenCalled();
    const iframe = frame()!;
    expect(iframe.getAttribute('src')).toBe(PAGE);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation');
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.getByRole('dialog', { name: 'Secure card page' })).toBeTruthy();
    // Swift's own page around it has no field of any kind.
    expect(document.querySelectorAll('input, textarea, select, form, [contenteditable]')).toHaveLength(0);
    view.unmount();
  });

  it('a message from the frame changes nothing: no "paid", the frame stays', async () => {
    const { view } = await payByCard();
    await waitFor(() => expect(frame()).not.toBeNull());
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { status: 'SUCCEEDED', paid: true }, origin: API_ORIGIN })); });
    expect(frame()).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/paid:/i);
    view.unmount();
  });

  it('Close closes the frame; the page then asks the server, and tells what the server says', async () => {
    const { calls, view } = await payByCard();
    await waitFor(() => expect(frame()).not.toBeNull());
    status = 'FAILED';
    await view.user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(frame()).toBeNull());
    expect(await screen.findByText("The payment didn't go through: the bank declined it, or the card has expired. You can try again.")).toBeTruthy();
    expect(calls.mock.calls.some(([url]) => String(url).endsWith('/card-sessions/card-session-1'))).toBe(true);
    view.unmount();
  });

  it('the server saying the card page is no longer open closes the frame (return detected by the server)', async () => {
    const { view } = await payByCard();
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(frame()).not.toBeNull();
    status = 'SUCCEEDED';
    await waitFor(() => expect(frame()).toBeNull(), { timeout: 10_000 });
    expect(await screen.findByText('Paid: GY$1,200 received.')).toBeTruthy();
    view.unmount();
  }, 20_000);

  it('a card page that is not on the API origin opens in this tab, never in a frame', async () => {
    hostedUrl = 'https://card-page.test/opaque';
    const { assign, view } = await payByCard();
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('https://card-page.test/opaque'));
    expect(frame()).toBeNull();
    view.unmount();
  });
});
