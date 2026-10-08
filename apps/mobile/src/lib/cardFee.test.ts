import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CardCheckoutSession, adoptableCardSession, cardBrand, cardExpiry, cardRemovedWords, cardLabel, cardMoney, cardPageReopenable, cardPaymentPending, cardPollDelay, cardSessionTone, cardSessionWords, cardSpoken, liveCard,
  type CardCheckoutView, type CardPointer, type CardSessionStart, type CardSessionView,
} from './cardFee';

const VISA = { id: 'card-1', brand: 'VISA', last4: '4242', expMonth: 4, expYear: 2031, status: 'ACTIVE' as const };
const live = (extra: Record<string, unknown> = {}) => ({ id: 'CARD', state: 'live', payNow: { amount: 1200, currencyCode: 'GYD' }, addCard: false, cardOnFile: null, ...extra });
const session = (status: CardSessionView['status'], extra: Partial<CardSessionView> = {}): CardSessionView => ({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status, expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', subscriptionStatus: 'PAST_DUE', testMode: false, ...extra });
const started = (extra: Partial<CardSessionStart> = {}): CardSessionStart => ({ sessionId: 'card-session-1', purpose: 'PAY_NOW', status: 'OPEN', hostedUrl: 'https://card-page.test/opaque', expiresAt: '2099-01-01T00:15:00Z', amount: 1200, currencyCode: 'GYD', testMode: false, ...extra });
function setup() {
  const views: CardCheckoutView[] = [];
  let saved: CardPointer | null = null;
  const transport = {
    start: vi.fn(async (purpose: 'ENROLL' | 'PAY_NOW', _key: string): Promise<CardSessionStart> => started({ purpose })),
    read: vi.fn(async (_id: string): Promise<CardSessionView> => session('OPEN')),
    open: vi.fn(async (_url: string): Promise<unknown> => ({ type: 'dismiss' })),
    refresh: vi.fn(),
    save: vi.fn((p: CardPointer | null) => { saved = p; }),
    load: vi.fn(() => saved),
  };
  let keys = 0;
  const s = new CardCheckoutSession(transport, () => `tap-key-${++keys}`, (v) => views.push(v), (e) => e as { status?: number; code?: string });
  return { s, transport, views, last: () => views[views.length - 1]!, saved: () => saved };
}
afterEach(() => vi.useRealTimers());

describe('the CARD pay action', () => {
  it('is live only with the server saying live and a whole price', () => {
    expect(liveCard([{ id: 'MMG_CHECKOUT', state: 'off' }, live()])).toEqual({ payNow: { amount: 1200, currencyCode: 'GYD' }, addCard: false, cardOnFile: null, testMode: false, testModeLabel: '' });
    for (const actions of [undefined, null, {}, [], [{ id: 'CARD', state: 'off' }], [{ id: 'CARD', state: 'coming_soon', payNow: { amount: 1200, currencyCode: 'GYD' } }],
      [live({ payNow: { amount: 0, currencyCode: 'GYD' } })], [live({ payNow: { amount: -5, currencyCode: 'GYD' } })], [live({ payNow: { amount: Number.NaN, currencyCode: 'GYD' } })],
      [live({ payNow: { amount: '1200', currencyCode: 'GYD' } })], [live({ payNow: { amount: 1200, currencyCode: 'gyd' } })], [live({ payNow: null })], [{ ...live(), id: 'card' }]]) {
      expect(liveCard(actions), JSON.stringify(actions)).toBeUndefined();
    }
  });
  it('the first CARD entry decides; Add card only on a real true', () => {
    expect(liveCard([{ id: 'CARD', state: 'off' }, live()])).toBeUndefined();
    expect(liveCard([live({ addCard: 'true' })])?.addCard).toBe(false);
    expect(liveCard([live({ addCard: true })])?.addCard).toBe(true);
  });
  it('shows a card on file only when it is whole and ACTIVE', () => {
    expect(liveCard([live({ cardOnFile: VISA })])?.cardOnFile).toEqual(VISA);
    for (const bad of [{ ...VISA, status: 'REVOKED' }, { ...VISA, last4: '42424' }, { ...VISA, last4: 'abcd' }, { ...VISA, expMonth: 13 }, { ...VISA, id: '' }, { ...VISA, status: 'LIVE' }, 'VISA 4242']) {
      expect(liveCard([live({ cardOnFile: bad })])?.cardOnFile, JSON.stringify(bad)).toBeNull();
    }
  });
  it('a test server is labelled, with the server words or ours', () => {
    expect(liveCard([live({ testMode: true, testModeLabel: 'TEST PAGE' })])).toMatchObject({ testMode: true, testModeLabel: 'TEST PAGE' });
    expect(liveCard([live({ testMode: true })])).toMatchObject({ testMode: true, testModeLabel: 'Test mode: no real card is charged.' });
    expect(liveCard([live({ testModeLabel: 'TEST PAGE' })])).toMatchObject({ testMode: false, testModeLabel: '' });
  });
});

describe('card words', () => {
  it('names a card by brand and last 4 only, and never echoes an unknown brand', () => {
    expect(cardLabel(VISA)).toBe('Visa •••• 4242');
    expect(cardSpoken(VISA)).toBe('Visa ending in 4242');
    expect(cardExpiry(VISA)).toBe('Expires 04/31');
    expect(cardBrand('MASTERCARD')).toBe('Mastercard'); expect(cardBrand('master-card')).toBe('Mastercard'); expect(cardBrand('SIMULATED')).toBe('Test card');
    for (const brand of ['POWERTRANZ', 'PowerTranz', 'AMEX', '<script>', '']) expect(cardBrand(brand)).toBe('Card');
  });
  it('prices like the rest of Swift', () => {
    expect(cardMoney(1200, 'GYD')).toBe('GY$1,200'); expect(cardMoney(1200.5, 'GYD')).toBe('GY$1,200.5'); expect(cardMoney(15, 'USD')).toBe('USD 15');
  });
  it.each([
    ['OPEN', false, "Finish on the card page. If your bank asks you to confirm it's you (3-D Secure), do it there."],
    ['OPEN', true, 'Checking with the bank…'],
    ['UNKNOWN', true, "Checking with the bank. Don't pay again."],
    ['FAILED', true, "The payment didn't go through: the bank declined it, or the card has expired. You can try again."],
    ['EXPIRED', true, 'This card page expired. If you paid, it will be credited once the bank confirms it.'],
    ['CANCELLED', true, "The card page couldn't open. Try again in a moment."],
    ['HELD', true, "We're checking this payment by hand. Don't pay again. Support will contact you."],
  ] as const)('a Pay now %s (returned %s) has truthful words', (status, returned, words) => expect(cardSessionWords(session(status), returned)).toBe(words));
  it('says paid or added only on SUCCEEDED', () => {
    expect(cardSessionWords(session('SUCCEEDED', { settlement: 'advanced' }))).toBe('Paid: GY$1,200 received.');
    expect(cardSessionWords(session('SUCCEEDED', { settlement: 'banked' }))).toBe('Payment received and added to your balance.');
    expect(cardSessionWords(session('SUCCEEDED', { purpose: 'ENROLL', card: VISA }))).toBe('Card added: Visa •••• 4242.');
    expect(cardSessionWords(session('FAILED', { purpose: 'ENROLL' }))).toBe('The card was not added: the bank declined it, or the card has expired.');
    expect(cardSessionWords(session('EXPIRED', { purpose: 'ENROLL' }))).toBe('This card page expired. You can start again.');
    for (const status of ['OPEN', 'UNKNOWN', 'FAILED', 'EXPIRED', 'CANCELLED', 'HELD'] as const) {
      for (const purpose of ['ENROLL', 'PAY_NOW'] as const) {
        for (const returned of [false, true]) expect(cardSessionWords(session(status, { purpose, card: VISA, settlement: 'advanced' }), returned)).not.toMatch(/paid:|card added|received|added to your balance/i);
      }
    }
  });
});

describe('card tones', () => {
  it('tints success, failure and waiting, never by colour alone', () => {
    expect(cardSessionTone(session('SUCCEEDED'))).toBe('success');
    for (const s of ['FAILED', 'CANCELLED'] as const) expect(cardSessionTone(session(s))).toBe('error');
    for (const s of ['OPEN', 'UNKNOWN', 'HELD'] as const) expect(cardSessionTone(session(s))).toBe('waiting');
    expect(cardSessionTone(session('EXPIRED'))).toBe('neutral');
  });
});

describe('following a card session', () => {
  it('polls every 3 s for a minute, then every 15 s to 11 minutes; only final states stop early', () => {
    expect(cardPollDelay(0, session('OPEN'))).toBe(3000); expect(cardPollDelay(59_999, session('UNKNOWN'))).toBe(3000);
    expect(cardPollDelay(60_000, session('UNKNOWN'))).toBe(15000); expect(cardPollDelay(660_000, session('OPEN'))).toBeNull();
    for (const s of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'HELD'] as const) expect(cardPollDelay(0, session(s))).toBeNull();
    // Not final for money after a Pay now: the server keeps asking the bank.
    expect(cardPollDelay(0, session('EXPIRED'))).toBe(3000);
    expect(cardPollDelay(0, session('EXPIRED', { purpose: 'ENROLL' }))).toBeNull();
    expect(cardPollDelay(0)).toBe(3000);
  });
  it('a Pay now that may still take money is pending; a page reopens only inside its window', () => {
    for (const s of ['OPEN', 'UNKNOWN', 'HELD'] as const) expect(cardPaymentPending(session(s))).toBe(true);
    for (const s of ['SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const) expect(cardPaymentPending(session(s))).toBe(false);
    expect(cardPaymentPending(session('OPEN', { purpose: 'ENROLL' }))).toBe(false);
    expect(cardPageReopenable(session('OPEN'), Date.parse('2099-01-01T00:14:59Z'))).toBe(true);
    expect(cardPageReopenable(session('OPEN'), Date.parse('2099-01-01T00:15:00Z'))).toBe(false);
    expect(cardPageReopenable(session('UNKNOWN'))).toBe(false);
  });
  it('opens the page once, keeps only the id and key, and follows until a final answer', async () => {
    vi.useFakeTimers();
    const { s, transport, last, saved } = setup();
    transport.read.mockResolvedValueOnce(session('OPEN')).mockResolvedValueOnce(session('UNKNOWN')).mockResolvedValue(session('SUCCEEDED', { settlement: 'advanced' }));
    await s.start('PAY_NOW');
    expect(transport.start).toHaveBeenCalledExactlyOnceWith('PAY_NOW', 'tap-key-1');
    expect(transport.open).toHaveBeenCalledExactlyOnceWith('https://card-page.test/opaque');
    expect(saved()).toEqual({ sessionId: 'card-session-1', purpose: 'PAY_NOW', key: 'tap-key-1' });
    expect(JSON.stringify(saved())).not.toContain('card-page.test');
    await vi.advanceTimersByTimeAsync(0);
    expect(last().session?.status).toBe('OPEN'); expect(transport.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(last().session?.status).toBe('UNKNOWN');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(last().session?.status).toBe('SUCCEEDED'); expect(transport.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(700_000);
    expect(transport.read).toHaveBeenCalledTimes(3);
  });
  it('a browser that cannot finish still follows; a page that is not https is never opened', async () => {
    const { s, transport } = setup();
    transport.open.mockRejectedValueOnce(new Error('browser'));
    await s.start('PAY_NOW');
    expect(transport.read).toHaveBeenCalledWith('card-session-1');
    s.dispose();
    const second = setup();
    second.transport.start.mockResolvedValueOnce(started({ hostedUrl: 'http://card-page.test/opaque' }));
    await second.s.start('PAY_NOW');
    expect(second.transport.open).not.toHaveBeenCalled();
    expect(second.transport.read).toHaveBeenCalledWith('card-session-1');
    second.s.dispose();
  });
  it('retries a tap with the same key after a network or server failure, and a new key after a refusal', async () => {
    const { s, transport, last } = setup();
    transport.start.mockRejectedValueOnce({ status: 502, code: 'CARD_SESSION_UNAVAILABLE' }).mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce({ status: 429, code: 'RATE_LIMITED' }).mockRejectedValueOnce({ status: 409, code: 'NOTHING_TO_PAY' });
    await s.start('PAY_NOW'); expect(last().error).toBe("The card page couldn't open. Try again in a moment.");
    await s.start('PAY_NOW'); expect(last().error).toBe("Couldn't open the card page. Try again.");
    await s.start('PAY_NOW'); expect(last().error).toBe('Too many tries. Wait a minute and try again.');
    await s.start('PAY_NOW'); expect(last().error).toBe("There's nothing to pay right now.");
    await s.start('PAY_NOW');
    expect(transport.start.mock.calls.map((c) => c[1])).toEqual(['tap-key-1', 'tap-key-1', 'tap-key-1', 'tap-key-1', 'tap-key-2']);
    s.dispose();
  });
  it('a server refusal hides the card choice; a pause says so; the server message is never shown', async () => {
    const off = setup();
    off.transport.start.mockRejectedValueOnce({ status: 409, code: 'PAY_ACTION_OFF', message: 'PowerTranz is not configured' });
    await off.s.start('PAY_NOW');
    expect(off.last()).toMatchObject({ off: true, error: '' }); expect(off.transport.refresh).toHaveBeenCalled();
    await off.s.start('PAY_NOW'); expect(off.transport.start).toHaveBeenCalledOnce();
    const paused = setup();
    paused.transport.start.mockRejectedValueOnce({ status: 503, code: 'CARD_RAIL_DISABLED', message: 'PowerTranz kill switch' });
    await paused.s.start('PAY_NOW');
    expect(paused.last()).toMatchObject({ off: true, error: 'Card payments are paused right now. Please use another way to pay.' });
    for (const v of [...off.views, ...paused.views]) expect(JSON.stringify(v)).not.toMatch(/powertranz/i);
  });
  it.each([
    ['REVIEW_DEMO_NO_MONEY', 403, "This demo account can't make payments.", true],
    ['ADD_CARD_OFF', 409, "Saving a card isn't available. You can still pay now by card.", false],
    ['PAYMENT_CONFIRMING', 409, "We're checking a payment. Don't pay again.", false],
    ['MOVER_FEE_PRICE_CHANGED', 409, 'Your weekly fee changed. Check the new amount and try again.', false],
    ['MOVER_FEE_REVIEW_REQUIRED', 409, 'Your weekly fee needs a check by our team first. Support will contact you.', false],
  ] as const)('%s has Swift\u2019s own words', async (code, status, words, off) => {
    const { s, transport, last } = setup();
    transport.start.mockRejectedValueOnce({ status, code, message: 'PowerTranz: ' + code });
    await s.start(code === 'ADD_CARD_OFF' ? 'ENROLL' : 'PAY_NOW');
    expect(last()).toMatchObject({ error: words, off });
    s.dispose();
  });
  it('a removal says whether a charge already on its way will still finish', () => {
    expect(cardRemovedWords({ card: VISA, paymentInProgress: true })).toBe('Card removed. A payment already on its way will finish. Nothing more will be charged to this card.');
    for (const answer of [{ card: VISA, paymentInProgress: false }, { card: VISA }, { paymentInProgress: 'true' }, null, undefined]) expect(cardRemovedWords(answer)).toBe('Card removed. Nothing more will be charged to it.');
  });
  it('Add card needs the accepted consent; a refusal for it shows the consent again', async () => {
    const { s, transport, last } = setup();
    transport.start.mockRejectedValueOnce({ status: 400, code: 'CARD_CONSENT_REQUIRED' });
    await s.start('ENROLL');
    expect(last()).toMatchObject({ consent: true, error: 'Agree to the weekly card charge to add a card.' });
    s.dispose();
  });
  it('one Pay now at a time; an open page is reopened with the same tap key, never a second session', async () => {
    vi.useFakeTimers();
    const { s, transport, last } = setup();
    await s.start('PAY_NOW');
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ returned: true, session: { status: 'OPEN' } });
    await s.start('PAY_NOW');
    expect(transport.start).toHaveBeenCalledOnce();
    await s.reopen();
    expect(transport.start).toHaveBeenLastCalledWith('PAY_NOW', 'tap-key-1');
    expect(transport.open).toHaveBeenCalledTimes(2);
    s.dispose();
  });
  it('an already-open page is followed, not duplicated', async () => {
    const { s, transport, last } = setup();
    await s.start('PAY_NOW');
    s.dispose();
    const again = setup();
    again.transport.load.mockReturnValue({ sessionId: 'card-session-1', purpose: 'PAY_NOW', key: 'tap-key-9' });
    again.transport.start.mockRejectedValueOnce({ status: 409, code: 'CARD_SESSION_OPEN' });
    again.s.resume();
    await again.s.start('PAY_NOW');
    expect(again.last().error).toBe('A card page is already open. Finish it there, or wait until it expires.');
    expect(again.transport.read).toHaveBeenCalledWith('card-session-1');
    expect(transport.read).toHaveBeenCalled(); expect(last().session).not.toBeNull();
    again.s.dispose();
  });
  it('a session the server does not know (or not this partner’s) is forgotten and shows nothing', async () => {
    const { s, transport, last, saved } = setup();
    transport.load.mockReturnValue({ sessionId: 'someone-else', purpose: 'PAY_NOW', key: 'tap-key-9' });
    transport.read.mockRejectedValue({ status: 404, code: 'CARD_SESSION_NOT_FOUND' });
    s.resume();
    await vi.waitFor(() => expect(transport.save).toHaveBeenCalledWith(null));
    expect(saved()).toBeNull(); expect(last()).toMatchObject({ session: null, error: '' });
  });
  it('an unreadable answer is never shown as a state', async () => {
    const { s, transport, last } = setup();
    transport.read.mockResolvedValue({ sessionId: 'card-session-1', status: 'PAID' } as unknown as CardSessionView);
    await s.start('PAY_NOW');
    await vi.waitFor(() => expect(last().error).toBe('Could not check your card payment. Refresh to try again.'));
    expect(last().session?.status).toBe('OPEN');
    s.dispose();
  });
});

describe('a new tab or an app restart: the server\'s latest card session', () => {
  it('a Pay now that may still take money is followed — never a second payment, never a page reopened without its tap key', async () => {
    vi.useFakeTimers();
    const { s, transport, last } = setup();
    transport.read.mockResolvedValueOnce(session('UNKNOWN')).mockResolvedValue(session('SUCCEEDED', { settlement: 'advanced' }));
    s.adopt(session('UNKNOWN'));
    expect(last().session?.status).toBe('UNKNOWN');
    expect(cardPaymentPending(last().session)).toBe(true);
    await s.start('PAY_NOW');
    expect(transport.start).not.toHaveBeenCalled();
    await s.reopen();
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.read).toHaveBeenCalledWith('card-session-1');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(last().session?.status).toBe('SUCCEEDED');
    expect(transport.refresh).toHaveBeenCalledOnce();
  });
  it('held for a person: shown, not polled; an open Add card page: followed', async () => {
    const held = setup();
    held.s.adopt(session('HELD'));
    expect(held.last().session?.status).toBe('HELD');
    expect(held.transport.read).not.toHaveBeenCalled();
    expect(adoptableCardSession(session('OPEN', { purpose: 'ENROLL' }))?.purpose).toBe('ENROLL');
  });
  it('ignored when this screen holds its own session, when finished, malformed or absent (an older server)', async () => {
    for (const latest of [session('SUCCEEDED'), session('FAILED'), session('EXPIRED'), session('CANCELLED'), session('EXPIRED', { purpose: 'ENROLL' }), { sessionId: 'x' }, null, undefined, 'OPEN']) {
      const { s, views, transport } = setup();
      s.adopt(latest);
      expect(views, JSON.stringify(latest)).toEqual([]);
      expect(transport.read).not.toHaveBeenCalled();
    }
    const own = setup();
    own.transport.load.mockReturnValue({ sessionId: 'mine-1', purpose: 'PAY_NOW', key: 'tap-key-9' });
    own.s.adopt(session('UNKNOWN'));
    expect(own.views).toEqual([]);
  });
});
