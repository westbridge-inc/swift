import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkoutReferences, checkoutWords, dueLine, FeeCheckoutSession, reopenableMmg, liveMmg, pollDelay, type CheckoutStart, type CheckoutStatus, type CheckoutView } from './weekly-fee';
const checkout = (status: CheckoutStatus['status']): CheckoutStatus => ({ ref: 'reference-1', status, amountGyd: 1200, currencyCode: 'GYD', createdAt: '2026-09-29T12:00:00Z', expiresAt: status === 'OPEN' ? '2099-09-29T13:00:00Z' : '2026-09-29T13:00:00Z', confirmedAt: status === 'CONFIRMED' ? '2026-09-29T12:02:00Z' : null, subscriptionStatus: 'ACTIVE' });
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
  it('renders the amount due without inventing zero or a next bill', () => {
    expect(dueLine({ status: 'ACTIVE' })).toBe('Amount due unavailable.');
    expect(dueLine({ status: 'ACTIVE', amountDueGyd: 0, nextBillingDate: '2026-10-06T12:00:00Z' })).toBe('Nothing due right now: your next bill is 6 Oct 2026');
    expect(dueLine({ status: 'PAST_DUE', amountDueGyd: '1200.50', gracePeriodEnd: '2026-10-01T12:00:00Z' })).toBe('GY$1,200.5 due by 1 Oct 2026');
  });
  it.each([
    ['OPEN', 'Finish paying on the MMG page.'], ['CONFIRMING', "Confirming your payment with MMG. Don't pay again."],
    ['CONFIRMED', 'Paid: GY$1,200 received on 29 Sept 2026.'], ['NOT_PAID', "MMG didn't complete this payment. You can try again."],
    ['EXPIRED', "This checkout expired. Your payment is being checked. Don't pay again. Support will help."],
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


describe('server reopen grant', () => {
  it('requires the same OPEN latest ref and an unexpired deadline', () => {
    const now = Date.parse('2026-10-08T23:00:00Z');
    const c = { ...checkout('OPEN'), expiresAt: '2026-10-08T23:30:00Z' };
    const grant = { ref: c.ref, expiresAt: c.expiresAt };
    const sub = { status: 'ACTIVE', latestMmgCheckout: c, reopenableMmgCheckout: grant };
    expect(reopenableMmg(sub, c, now)).toEqual(grant);
    expect(reopenableMmg({ ...sub, reopenableMmgCheckout: null }, c, now)).toBeUndefined();
    expect(reopenableMmg(sub, { ...c, status: 'CONFIRMING' }, now)).toBeUndefined();
    expect(reopenableMmg({ ...sub, latestMmgCheckout: { ...c, ref: 'another-ref' } }, c, now)).toBeUndefined();
    expect(reopenableMmg(sub, c, Date.parse(c.expiresAt))).toBeUndefined();
  });
  it('expiry blocks another session Pay until fresh server state proves resolution', async () => {
    vi.useFakeTimers(); const { session, transport } = setup();
    session.reconcile(checkout('EXPIRED')); await session.pay();
    expect(transport.start).not.toHaveBeenCalled();
    session.reconcile(checkout('NOT_PAID')); await session.pay();
    expect(transport.start).toHaveBeenCalledOnce(); session.dispose();
  });
});


describe('checkout deadline before the next server refresh', () => {
  it('a stale OPEN at its deadline tells the partner it is being checked', () => {
    const c = { ...checkout('OPEN'), expiresAt: '2026-10-08T23:30:00Z' };
    vi.useFakeTimers(); vi.setSystemTime(new Date(c.expiresAt));
    expect(checkoutWords(c, true)).toBe("This checkout expired. Your payment is being checked. Don't pay again. Support will help.");
  });
});


describe('reopen authority changes before POST', () => {
  it('PAYMENT_CONFIRMING follows the reference and blocks another tap', async () => {
    vi.useFakeTimers(); const { session, transport, views } = setup();
    transport.start.mockRejectedValue({ status: 409, code: 'PAYMENT_CONFIRMING', details: { ref: 'reference-1' } });
    transport.read.mockResolvedValue(checkout('HELD'));
    await session.pay(); await vi.advanceTimersByTimeAsync(0); await session.pay();
    expect(transport.start).toHaveBeenCalledOnce(); expect(transport.open).not.toHaveBeenCalled();
    expect(transport.read).toHaveBeenCalledWith('reference-1');
    expect(views.at(-1)?.blocked).toBe(true); session.dispose();
  });
});
