import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutReferences, checkoutWords, feeStatusOf, feeStatusPill, FeeCheckoutSession, liveMmg, pollDelay, type CheckoutStart, type CheckoutStatus, type CheckoutView } from './weeklyFee';
const checkout = (status: CheckoutStatus['status']): CheckoutStatus => ({ ref: 'reference-1', status, amountGyd: 1200, currencyCode: 'GYD', createdAt: '2026-09-29T12:00:00Z', expiresAt: '2026-09-29T13:00:00Z', confirmedAt: status === 'CONFIRMED' ? '2026-09-29T12:02:00Z' : null, subscriptionStatus: 'ACTIVE' });
function setup() {
  const views: CheckoutView[] = [];
  const transport = { start: vi.fn(async (_key: string): Promise<CheckoutStart> => ({ ref: 'reference-1', status: 'OPEN' as const, checkoutUrl: 'https://checkout.test/private', amountGyd: 1200, currencyCode: 'GYD' as const, expiresAt: '2026-09-29T13:00:00Z' })), read: vi.fn(async () => checkout('OPEN')), open: vi.fn(async (_url: string): Promise<unknown> => ({ type: 'success', url: 'swift://pay/mmg/return?status=CONFIRMED' })), refresh: vi.fn() };
  let keys = 0;
  const session = new FeeCheckoutSession(transport, () => `tap-key-${++keys}`, (v) => views.push(v), (e) => e as { status?: number; code?: string; details?: { ref?: string } });
  return { session, transport, views };
}
afterEach(() => vi.useRealTimers());
describe('weekly fee contract', () => {
  it('shows only live MMG, with no fallback for off or absent payActions', () => {
    expect(liveMmg({ status: 'ACTIVE', payActions: [{ id: 'MMG_CHECKOUT', state: 'live', amountGyd: 1200, currencyCode: 'GYD' }] })?.amountGyd).toBe(1200);
    expect(liveMmg({ status: 'ACTIVE', payActions: [{ id: 'MMG_CHECKOUT', state: 'off' }, { id: 'CARD', state: 'off' }] })).toBeUndefined();
    expect(liveMmg({ status: 'ACTIVE' })).toBeUndefined();
  });
  // [FEE-STATUS · owner 25 Oct 2026] The store's screen read "Nothing due right now: your next bill is 13 Oct
  // 2026" on 25 October (the old dueLine). The API's words lead; an older API's row is worded by the same rules.
  const NOW = Date.parse('2026-10-25T16:52:00Z');
  it('renders the amount due without inventing zero, and a date that has passed is never a next bill', () => {
    expect(feeStatusOf({ status: 'ACTIVE', nextBillingDate: '2026-10-14T00:26:00Z' }, NOW).headline).toBe('Amount due unavailable.');
    const owner = feeStatusOf({ status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-14T00:26:00Z' }, NOW);
    expect(owner).toMatchObject({ state: 'COVERED', headline: 'Nothing to pay for the week from 13 Oct 2026' });
    expect(JSON.stringify(owner)).not.toMatch(/next bill|active until|nothing due right now/i);
    expect(feeStatusOf({ status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-11-01T00:26:00Z' }, NOW)).toMatchObject({ state: 'PAID', headline: 'Paid until 31 Oct 2026' });
    expect(feeStatusOf({ status: 'ACTIVE', amountDueGyd: 15000, nextBillingDate: '2026-10-14T00:26:00Z' }, NOW))
      .toMatchObject({ state: 'DUE', headline: 'Payment due since 13 Oct 2026', detail: 'GY$15,000 to pay.' });
    expect(feeStatusOf({ status: 'PAST_DUE', amountDueGyd: '1200.50', nextBillingDate: '2026-10-24T12:00:00Z', gracePeriodEnd: '2026-10-26T12:00:00Z' }, NOW).detail)
      .toBe('GY$1,200.5 to pay. Pay by 26 Oct 2026 to keep receiving work.');
    expect(feeStatusOf({ status: 'PAST_DUE', amountDueGyd: 1200, nextBillingDate: '2026-10-20T12:00:00Z', gracePeriodEnd: '2026-10-22T12:00:00Z' }, NOW).detail).toBe('GY$1,200 to pay.');
  });
  it("the API's feeStatus is shown as sent, never re-derived", () => {
    const sent = { state: 'CHECKING' as const, headline: 'Checking your payment of GY$15,000 (began 16 Oct 2026)', detail: "Don't pay again while we check.", date: '2026-10-16T21:20:43.000Z' };
    expect(feeStatusOf({ status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-14T00:26:00Z', feeStatus: sent }, NOW)).toBe(sent);
    expect(feeStatusOf({ status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-14T00:26:00Z', feeStatus: { ...sent, headline: '' } }, NOW).state).toBe('COVERED');
  });
  it('checking, suspended, stopped, trial and closed say so in plain words', () => {
    const held = { ref: 'r', status: 'HELD' as const, amountGyd: 15000, currencyCode: 'GYD' as const, createdAt: '2026-10-16T21:20:43Z', expiresAt: '2026-10-16T21:50:43Z', confirmedAt: null, subscriptionStatus: 'ACTIVE' };
    expect(feeStatusOf({ status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-14T00:26:00Z', latestMmgCheckout: held }, NOW).headline).toBe('Checking your payment of GY$15,000 (began 16 Oct 2026)');
    expect(feeStatusOf({ status: 'SUSPENDED', amountDueGyd: 15000, nextBillingDate: '2026-10-14T00:26:00Z' }, NOW))
      .toMatchObject({ headline: 'Account suspended', detail: 'GY$15,000 due since 13 Oct 2026. Pay it to start receiving work again.' });
    expect(feeStatusOf({ status: 'PAUSED', amountDueGyd: 0, autoRenew: false }, NOW).headline).toBe('Weekly billing stopped');
    expect(feeStatusOf({ status: 'TRIAL', isTrialActive: true, amountDueGyd: 0, trialEndDate: '2026-11-05T15:00:00Z', nextBillingDate: '2026-11-05T15:00:00Z' }, NOW).headline).toBe('Free trial until 5 Nov 2026');
    expect(feeStatusOf({ status: 'TRIAL', isTrialActive: true, amountDueGyd: 15000, trialEndDate: '2026-10-20T15:00:00Z', nextBillingDate: '2026-10-20T15:00:00Z' }, NOW).headline).toBe('Payment due since 20 Oct 2026');
    expect(feeStatusOf({ status: 'CANCELLED' }, NOW).headline).toBe('Subscription closed');
    expect(feeStatusPill('DUE')).toEqual({ label: 'Payment due', tone: 'warning' });
    expect(feeStatusPill('COVERED').label).toBe('Paid');
  });
  it.each([
    ['OPEN', 'Finish paying on the MMG page.'], ['CONFIRMING', "Confirming your payment with MMG. Don't pay again."],
    ['CONFIRMED', 'Paid: GY$1,200 received on 29 Sept 2026.'], ['NOT_PAID', "MMG didn't complete this payment. You can try again."],
    ['EXPIRED', 'This checkout expired. If you paid, it will be credited once MMG confirms it.'],
    ['HELD', "We're checking this payment by hand. Don't pay again. Support will contact you."],
  ] as const)('%s has truthful words', (state, words) => expect(checkoutWords(checkout(state))).toBe(words));
  it("references: the Swift reference always, MMG's transaction ID only on CONFIRMED, nothing invented", () => {
    const ids = { swiftReference: '175933829900012345', mmgTransactionId: '20402048536279' };
    expect(checkoutReferences({ ...checkout('CONFIRMED'), ...ids })).toEqual([
      { label: 'Swift reference', value: '175933829900012345' }, { label: 'MMG transaction ID', value: '20402048536279' },
    ]);
    for (const state of ['OPEN', 'CONFIRMING', 'NOT_PAID', 'EXPIRED', 'HELD'] as const) {
      expect(checkoutReferences({ ...checkout(state), ...ids }), state).toEqual([{ label: 'Swift reference', value: '175933829900012345' }]);
    }
    expect(checkoutReferences(checkout('CONFIRMED'))).toEqual([]);
  });
  it('sets the two cadence windows and only the three terminal states stop early', () => {
    expect(pollDelay(0, 'OPEN')).toBe(3000); expect(pollDelay(59_999, 'CONFIRMING')).toBe(3000);
    expect(pollDelay(60_000, 'EXPIRED')).toBe(15_000); expect(pollDelay(659_999, 'OPEN')).toBe(15_000);
    expect(pollDelay(660_000, 'OPEN')).toBeNull();
    for (const state of ['CONFIRMED', 'NOT_PAID', 'HELD'] as const) expect(pollDelay(0, state)).toBeNull();
  });
  it.each(['success', 'cancel', 'dismiss', 'throw'])('browser %s never marks paid; GET is the only authority', async (type) => {
    vi.useFakeTimers(); const { session, transport, views } = setup();
    transport.open.mockImplementation(async () => { if (type === 'throw') throw Error('browser'); return { type, url: 'swift://pay/mmg/return?state=CONFIRMED' }; });
    await session.pay(); await vi.advanceTimersByTimeAsync(0);
    expect(transport.open).toHaveBeenCalledWith('https://checkout.test/private');
    expect(views.at(-1)?.checkout?.status).toBe('OPEN'); expect(views.at(-1)?.returned).toBe(true);
    expect(views.some((v) => v.checkout?.status === 'CONFIRMED')).toBe(false);
    expect(checkoutWords(views.at(-1)!.checkout!, true)).toBe('Waiting for MMG…');
    expect(JSON.stringify(views)).not.toContain('https://checkout.test/private');
    transport.read.mockResolvedValue(checkout('CONFIRMED'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(views.at(-1)?.checkout?.status).toBe('CONFIRMED'); expect(transport.refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(900_000); expect(transport.read).toHaveBeenCalledTimes(2);
    session.dispose();
  });
  it('polls at 3s then 15s and stops after eleven minutes', async () => {
    vi.useFakeTimers(); const { session, transport } = setup(); session.follow('reference-1');
    await vi.advanceTimersByTimeAsync(60_000); expect(transport.read).toHaveBeenCalledTimes(21);
    await vi.advanceTimersByTimeAsync(14_999); expect(transport.read).toHaveBeenCalledTimes(21);
    await vi.advanceTimersByTimeAsync(1); expect(transport.read).toHaveBeenCalledTimes(22);
    await vi.advanceTimersByTimeAsync(900_000); expect(transport.read).toHaveBeenCalledTimes(61);
    session.dispose();
  });
  it('accepts an OPEN hand-back and makes a new key for each successful tap', async () => {
    vi.useFakeTimers(); const { session, transport } = setup(); await session.pay(); await session.pay();
    expect(transport.start.mock.calls.map(([key]) => key)).toEqual(['tap-key-1', 'tap-key-2']);
    expect(transport.open).toHaveBeenCalledTimes(2); session.dispose();
  });
  it.each([
    ['CONFIRMING', null], ['CONFIRMED', null], ['CONFIRMING', 'https://checkout.test/private'], ['OPEN', null],
  ] as const)('replayed %s with URL %s polls without reopening the checkout page', async (status, checkoutUrl) => {
    vi.useFakeTimers();
    const { session, transport, views } = setup();
    transport.start.mockResolvedValue({ ...checkout(status), checkoutUrl });
    transport.read.mockResolvedValue(checkout(status));
    await session.pay(); await vi.advanceTimersByTimeAsync(0);
    expect(transport.open).not.toHaveBeenCalled();
    expect(transport.read).toHaveBeenCalledWith('reference-1');
    expect(views.at(-1)?.checkout?.status).toBe(status);
    if (status === 'CONFIRMING') expect(views.at(-1)?.blocked).toBe(true);
    session.dispose();
  });
  it('retries an uncertain tap with its original key and suppresses double taps', async () => {
    const { session, transport } = setup(); transport.start.mockRejectedValueOnce(Error('offline'));
    await session.pay(); transport.start.mockImplementation(() => new Promise(() => {}));
    void session.pay(); void session.pay();
    expect(transport.start.mock.calls.map(([key]) => key)).toEqual(['tap-key-1', 'tap-key-1']); session.dispose();
  });
  it('409 CHECKOUT_CONFIRMING follows its ref, forbids another payment and never opens MMG', async () => {
    vi.useFakeTimers(); const { session, transport, views } = setup();
    transport.start.mockRejectedValue({ status: 409, code: 'CHECKOUT_CONFIRMING', details: { ref: 'earlier-ref' } });
    transport.read.mockResolvedValue(checkout('CONFIRMING'));
    await session.pay(); await vi.advanceTimersByTimeAsync(0); await session.pay();
    expect(transport.read).toHaveBeenCalledWith('earlier-ref'); expect(transport.start).toHaveBeenCalledOnce();
    expect(transport.open).not.toHaveBeenCalled(); expect(views.at(-1)?.blocked).toBe(true); session.dispose();
  });
  it('off/forbidden refetches and hides Pay; unavailable preserves the retry key', async () => {
    for (const failure of [{ status: 403 }, { status: 409, code: 'PAY_ACTION_OFF' }]) {
      const { session, transport, views } = setup(); transport.start.mockRejectedValue(failure); await session.pay();
      expect(views.at(-1)?.blocked).toBe(true); expect(transport.refresh).toHaveBeenCalledOnce(); session.dispose();
    }
    const { session, transport, views } = setup(); transport.start.mockRejectedValue({ status: 503, code: 'MMG_CHECKOUT_UNAVAILABLE' });
    await session.pay(); expect(views.at(-1)?.error).toBe('Try again in a minute.'); session.dispose();
  });
  it('refreshes expired checkouts on focus, ignoring push claims, and discards late replies on unmount', async () => {
    vi.useFakeTimers(); const { session, transport, views } = setup();
    session.focus(checkout('EXPIRED'), 'push-ref'); await vi.advanceTimersByTimeAsync(0);
    expect(transport.read).toHaveBeenCalledWith('push-ref'); expect(views.at(-1)?.checkout?.status).toBe('OPEN');
    session.dispose(); const count = views.length; await vi.advanceTimersByTimeAsync(900_000); expect(views).toHaveLength(count);
  });
  it('reconciles late CONFIRMED for the same ref without an older poll overwriting it', async () => {
    vi.useFakeTimers(); const { session, transport, views } = setup();
    transport.read.mockResolvedValueOnce(checkout('EXPIRED'));
    session.follow('reference-1'); await vi.advanceTimersByTimeAsync(0);
    expect(checkoutWords(views.at(-1)!.checkout!)).toContain('expired');
    let reply!: (_value: CheckoutStatus) => void;
    transport.read.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    await vi.advanceTimersByTimeAsync(3000);
    session.reconcile(checkout('CONFIRMED'));
    expect(checkoutWords(views.at(-1)!.checkout!)).toContain('Paid:');
    reply(checkout('EXPIRED')); await vi.advanceTimersByTimeAsync(0);
    expect(checkoutWords(views.at(-1)!.checkout!)).toContain('Paid:');
    session.dispose();
  });
  it('does not replace a followed reference with another subscription checkout', async () => {
    vi.useFakeTimers(); const { session, transport, views } = setup();
    transport.read.mockResolvedValue(checkout('EXPIRED'));
    session.follow('reference-1'); await vi.advanceTimersByTimeAsync(0);
    session.reconcile({ ...checkout('CONFIRMED'), ref: 'other-ref' });
    expect(views.at(-1)!.checkout!.ref).toBe('reference-1');
    expect(views.at(-1)!.checkout!.status).toBe('EXPIRED'); session.dispose();
  });

  it('reconciles the followed ref from recent history when a newer checkout exists', async () => {
    vi.useFakeTimers(); const { session, transport, views } = setup();
    transport.read.mockResolvedValue(checkout('EXPIRED'));
    session.follow('reference-1'); await vi.advanceTimersByTimeAsync(0);
    session.reconcile({ ...checkout('OPEN'), ref: 'newer-ref' }, [checkout('CONFIRMED')]);
    expect(checkoutWords(views.at(-1)!.checkout!)).toContain('Paid:'); session.dispose();
  });

});
