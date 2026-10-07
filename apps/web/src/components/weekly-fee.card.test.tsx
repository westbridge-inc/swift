import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeeklyFee } from './weekly-fee';
import { mockApi, renderWithQuery, type ApiRequest } from '@/test/test-utils';
import { setSelectedStore } from '@/lib/auth';

// [PT-3] The one weekly-fee page on the web, card half (CARD-CHECKOUT-API). The page
// renders the server's payActions and the server's read of a card session, nothing else.
const MMG = { id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' };
const VISA = { id: 'card-1', brand: 'VISA', last4: '4242', expMonth: 4, expYear: 2031, status: 'ACTIVE' };
const cardLive = (extra: Record<string, unknown> = {}) => ({ id: 'CARD', state: 'live', payNow: { amount: 1200, currencyCode: 'GYD' }, addCard: false, cardOnFile: null, ...extra });
const subscription = (...payActions: unknown[]) => ({ success: true, data: { status: 'PAST_DUE', amountDueGyd: 1200, payActions, latestMmgCheckout: null, recentCheckouts: [] } });
const session = (status: string, extra: Record<string, unknown> = {}) => ({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status, expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', subscriptionStatus: 'PAST_DUE', testMode: false, ...extra });
const POINTER = 'swift_web_checkout_attempt:card-fee:vendor:store-card';
const PROCESSOR = /power\s*-?\s*tranz/i;
afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); });

/** One fake API: the subscription, and the card routes answering from `reads`. */
function api(sub: unknown, reads: Array<unknown> = [session('OPEN')], start?: (_r: ApiRequest) => { status?: number; body: unknown }) {
  let read = 0;
  return mockApi((r) => {
    const path = r.url.pathname;
    if (path.endsWith('/subscription')) return { body: sub };
    if (path.endsWith('/card-sessions') && r.method === 'POST') return start?.(r) ?? { status: 201, body: { success: true, data: { sessionId: 'card-session-1', purpose: JSON.parse(String(r.init?.body)).purpose, status: 'OPEN', hostedUrl: 'https://card-page.test/opaque', expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', testMode: false } } };
    if (path.includes('/card-sessions/')) { const reply = reads[Math.min(read++, reads.length - 1)]; return reply && typeof reply === 'object' && 'status' in reply && typeof reply.status === 'number' ? reply as { status: number; body: unknown } : { body: { success: true, data: reply } }; }
    if (path.includes('/cards/') && r.method === 'DELETE') return { body: { success: true, data: { card: { ...VISA, status: 'REVOKED' }, paymentInProgress: true } } };
    return { status: 404, body: { success: false, error: { code: 'NOT_FOUND' } } };
  });
}

describe('the card choice follows the server', () => {
  it.each([
    ['off', [MMG, { id: 'CARD', state: 'off' }]],
    ['absent', [MMG]],
    ['a zero price', [MMG, cardLive({ payNow: { amount: 0, currencyCode: 'GYD' } })]],
    ['an unknown state', [MMG, { id: 'CARD', state: 'coming_soon' }]],
  ])('is hidden, never teased, when CARD is %s', async (_case, actions) => {
    const calls = api(subscription(...actions));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await screen.findByRole('button', { name: 'Pay GY$1,200 with MMG' });
    expect(document.body.textContent).not.toMatch(/card|visa|mastercard|coming soon/i);
    expect(calls.mock.calls.some(([url]) => String(url).includes('card'))).toBe(false);
    view.unmount();
  });
  it('is shown beside MMG when CARD is live, with no card field of Swift’s own', async () => {
    api(subscription(MMG, cardLive({ cardOnFile: VISA, addCard: true })));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByRole('heading', { name: 'Pay by card (Visa / Mastercard)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Choose how to pay' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pay GY$1,200 with MMG' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pay GY$1,200 by card' })).toBeTruthy();
    expect(document.body.textContent).toContain('Visa •••• 4242');
    expect(screen.getByText('Visa ending in 4242')).toBeTruthy();
    expect(document.body.textContent).toContain('Expires 04/31');
    await view.user.click(screen.getByRole('button', { name: 'Change card' }));
    expect(screen.getByText('Charge this card each week?')).toBeTruthy();
    expect(document.querySelectorAll('input, textarea, select, iframe, form, [contenteditable]')).toHaveLength(0);
    view.unmount();
  });
  it('Add card is offered only when the server allows it', async () => {
    api(subscription(MMG, cardLive()));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await screen.findByRole('button', { name: 'Pay GY$1,200 by card' });
    expect(screen.queryByRole('button', { name: /use (a|a different) card for the weekly fee/i })).toBeNull();
    view.unmount();
  });
});

describe('paying by card', () => {
  it('starts a Pay now with a new key, sends no amount, and opens the hosted page in this tab', async () => {
    setSelectedStore('store-card');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const posts: ApiRequest[] = [];
    api(subscription(MMG, cardLive()), [session('OPEN')], (r) => { posts.push(r); return { status: 201, body: { success: true, data: { sessionId: 'card-session-1', purpose: 'PAY_NOW', status: 'OPEN', hostedUrl: 'https://card-page.test/opaque', expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', testMode: false } } }; });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 by card' }));
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith('https://card-page.test/opaque'));
    const headers = new Headers(posts[0]!.init?.headers);
    expect(posts[0]!.url.pathname).toBe('/api/v1/vendor/subscription/card-sessions');
    expect(JSON.parse(String(posts[0]!.init?.body))).toEqual({ purpose: 'PAY_NOW' });
    expect(headers.get('Idempotency-Key')).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(headers.get('x-client-platform')).toBe('web');
    expect(headers.get('x-vendor-id')).toBe('store-card');
    const kept = sessionStorage.getItem(POINTER)!;
    expect(JSON.parse(kept)).toEqual({ sessionId: 'card-session-1', purpose: 'PAY_NOW', key: headers.get('Idempotency-Key') });
    expect(kept).not.toContain('card-page.test');
    view.unmount();
  });
  it('back from the card page: UNKNOWN says do not pay again and hides every button; only SUCCEEDED says paid', async () => {
    setSelectedStore('store-card');
    sessionStorage.setItem(POINTER, JSON.stringify({ sessionId: 'card-session-1', purpose: 'PAY_NOW', key: 'tap-key-0001' }));
    let status = 'UNKNOWN';
    const calls = mockApi((r) => r.url.pathname.endsWith('/subscription')
      ? { body: subscription(MMG, cardLive()) }
      : { body: { success: true, data: session(status, status === 'SUCCEEDED' ? { settlement: 'advanced' } : {}) } });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText("Checking with the bank. Don't pay again.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/paid:/i);
    expect(screen.queryByRole('button', { name: /^Pay GY/ })).toBeNull();
    status = 'SUCCEEDED';
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByText('Paid: GY$1,200 received.')).toBeTruthy();
    expect(calls.mock.calls.filter(([url]) => String(url).endsWith('/card-sessions/card-session-1')).length).toBeGreaterThanOrEqual(2);
    view.unmount();
  });
  it.each([
    ['FAILED', "The payment didn't go through: the bank declined it, or the card has expired. You can try again.", true],
    ['HELD', "We're checking this payment by hand. Don't pay again. Support will contact you.", false],
    ['EXPIRED', 'This card page expired. If you paid, it will be credited once the bank confirms it.', true],
  ])('%s is told plainly, from the server', async (status, words, payAgain) => {
    setSelectedStore('store-card');
    sessionStorage.setItem(POINTER, JSON.stringify({ sessionId: 'card-session-1', purpose: 'PAY_NOW', key: 'tap-key-0001' }));
    api(subscription(MMG, cardLive()), [session(status)]);
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText(words)).toBeTruthy();
    expect(!!screen.queryByRole('button', { name: 'Pay GY$1,200 by card' })).toBe(payAgain);
    expect(!!screen.queryByRole('button', { name: 'Pay GY$1,200 with MMG' })).toBe(payAgain);
    view.unmount();
  });
  it('no new card is offered while a card payment is still being answered', async () => {
    setSelectedStore('store-card');
    sessionStorage.setItem(POINTER, JSON.stringify({ sessionId: 'card-session-1', purpose: 'PAY_NOW', key: 'tap-key-0001' }));
    api(subscription(MMG, cardLive({ addCard: true })), [session('UNKNOWN')]);
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText("Checking with the bank. Don't pay again.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use a card for the weekly fee' })).toBeNull();
    view.unmount();
  });
  it('a session the server does not know is forgotten and nothing is shown', async () => {
    setSelectedStore('store-card');
    sessionStorage.setItem(POINTER, JSON.stringify({ sessionId: 'someone-else', purpose: 'PAY_NOW', key: 'tap-key-0001' }));
    api(subscription(MMG, { id: 'CARD', state: 'off' }), [{ status: 404, body: { success: false, error: { code: 'CARD_SESSION_NOT_FOUND' } } }]);
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await waitFor(() => expect(sessionStorage.getItem(POINTER)).toBeNull());
    expect(document.body.textContent).not.toMatch(/card/i);
    view.unmount();
  });
  it('a card is not offered while an MMG payment is being confirmed', async () => {
    const confirming = { ref: 'mmg-ref', status: 'CONFIRMING', amountGyd: 1200, currencyCode: 'GYD', createdAt: '2026-10-06T12:00:00Z', expiresAt: '2026-10-06T12:30:00Z', confirmedAt: null, subscriptionStatus: 'PAST_DUE' };
    mockApi((r) => r.url.pathname.endsWith('/mmg-ref') ? { body: { success: true, data: confirming } } : { body: { success: true, data: { ...subscription(MMG, cardLive()).data, latestMmgCheckout: confirming } } });
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText("Confirming your payment with MMG. Don't pay again.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pay GY$1,200 by card' })).toBeNull();
    view.unmount();
  });
  it('a test server labels the card screen', async () => {
    api(subscription(MMG, cardLive({ testMode: true, testModeLabel: 'TEST PAGE: no real money' })));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    expect(await screen.findByText('TEST PAGE: no real money')).toBeTruthy();
    view.unmount();
  });
  it('removing the saved card asks first, then calls the server', async () => {
    setSelectedStore('store-card');
    const calls = api(subscription(MMG, cardLive({ cardOnFile: VISA })));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await view.user.click(await screen.findByRole('button', { name: 'Remove card' }));
    expect(screen.getByText('Visa •••• 4242 will not be charged again. Your weekly fee stays due until you pay it another way.')).toBeTruthy();
    expect(calls.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await view.user.click(screen.getByRole('button', { name: 'Remove card' }));
    await waitFor(() => expect(calls.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/api/v1/vendor/subscription/cards/card-1'))).toBe(true));
    expect(await screen.findByText('Card removed. A payment already on its way will finish. Nothing more will be charged to this card.')).toBeTruthy();
    view.unmount();
  });
});

describe('the processor is never named on the page', () => {
  it.each(['OPEN', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'HELD'])('%s, whatever the server sends', async (status) => {
    setSelectedStore('store-card');
    sessionStorage.setItem(POINTER, JSON.stringify({ sessionId: 'card-session-1', purpose: 'ENROLL', key: 'tap-key-0001' }));
    api(subscription(MMG, cardLive({ cardOnFile: { ...VISA, brand: 'POWERTRANZ' }, addCard: true, testMode: true, testModeLabel: 'TEST PAGE' })), [session(status, { purpose: 'ENROLL', card: { ...VISA, brand: 'PowerTranz' } })]);
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await screen.findByRole('heading', { name: 'Pay by card (Visa / Mastercard)' });
    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
    expect(document.body.innerHTML).not.toMatch(PROCESSOR);
    view.unmount();
  });
  it('in an error, even when the server names it', async () => {
    api(subscription(MMG, cardLive()), [session('OPEN')], () => ({ status: 502, body: { success: false, error: { code: 'CARD_SESSION_UNAVAILABLE', message: 'PowerTranz said no' } } }));
    const view = renderWithQuery(<WeeklyFee family="vendor" />);
    await view.user.click(await screen.findByRole('button', { name: 'Pay GY$1,200 by card' }));
    expect(await screen.findByText("The card page couldn't open. Try again in a moment.")).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(PROCESSOR);
    view.unmount();
  });
});
