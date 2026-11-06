import { describe, expect, it, vi } from 'vitest';
import { FeeCheckoutSession, PAY_AHEAD_REFUSED, weekChoices, weeksWords, type CheckoutStart, type CheckoutView } from './weeklyFee';

// [OWNER 6 Nov 2026, up to four weeks ahead; replaces owner #62's one week] The
// weekly fee can be paid up to four weeks ahead: the partner picks 1 to 4 weeks
// from what the server says fits. When the server still refuses a checkout for
// the limit (409 PAY_AHEAD_LIMIT: something else filled the room), the partner
// reads that it can't take that many weeks and the fee is read again — not
// "Could not open MMG". (The website's copy is the same file, by census.)

function setup(failure: { status?: number; code?: string } | null) {
  const views: CheckoutView[] = [];
  const transport = {
    start: vi.fn(async (_key: string, _weeks?: number): Promise<CheckoutStart> => {
      if (failure) throw failure;
      return { ref: 'ref-1', status: 'OPEN', checkoutUrl: 'https://mmg.example/pay', amountGyd: 8400, currencyCode: 'GYD', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    }),
    reopen: vi.fn(),
    read: vi.fn(async () => { throw new Error('not read here'); }),
    open: vi.fn(async () => undefined),
    refresh: vi.fn(),
  };
  let n = 0;
  const session = new FeeCheckoutSession(transport as never, () => `tap-key-${++n}`, (v) => views.push(v), (e) => e as { status?: number; code?: string });
  return { session, transport, views };
}

describe('[owner 6 Nov] a checkout refused at the four-week limit', () => {
  it('says Swift cannot take that many weeks now, opens nothing, reads the fee again, and keeps the next tap fresh', async () => {
    const { session, transport, views } = setup({ status: 409, code: 'PAY_AHEAD_LIMIT' });
    session.activate();
    await session.pay(4);
    expect(transport.open).not.toHaveBeenCalled();
    expect(transport.refresh).toHaveBeenCalled();
    expect(views.at(-1)?.error).toBe(PAY_AHEAD_REFUSED);
    expect(PAY_AHEAD_REFUSED).toBe("Swift can't take that many weeks now. Refresh to see what is already paid and what you can pay.");
    await session.pay(4);
    expect(transport.start.mock.calls.map((c) => c[0])).toEqual(['tap-key-1', 'tap-key-2']);
  });

  it('any other refusal keeps its own words', async () => {
    const { session, views } = setup({ status: 409, code: 'SOMETHING_ELSE' });
    session.activate();
    await session.pay();
    expect(views.at(-1)?.error).toBe('Could not open MMG. Try again.');
  });
});

describe('[owner 6 Nov] choosing how many weeks', () => {
  it('the choices are the server’s; an older API (no weekOptions) is one week at the amount it states', () => {
    const live = { id: 'MMG_CHECKOUT', state: 'live', amountGyd: 2100, currencyCode: 'GYD' } as const;
    expect(weekChoices(live)).toEqual([{ weeks: 1, amountGyd: 2100 }]);
    const four = [{ weeks: 1, amountGyd: 2100 }, { weeks: 2, amountGyd: 4200 }, { weeks: 3, amountGyd: 6300 }, { weeks: 4, amountGyd: 8400 }];
    expect(weekChoices({ ...live, weekOptions: four })).toEqual(four);
    expect(weekChoices({ ...live, weekOptions: [] })).toEqual([{ weeks: 1, amountGyd: 2100 }]);
    expect([weeksWords(1), weeksWords(4)]).toEqual(['1 week', '4 weeks']);
  });

  it('the weeks chosen go to the server; a retry of the same tap keeps its key, another choice is a new tap', async () => {
    const { session, transport } = setup({ status: 503, code: 'MMG_CHECKOUT_UNAVAILABLE' });
    session.activate();
    await session.pay(3);
    await session.pay(3);
    await session.pay(2);
    expect(transport.start.mock.calls).toEqual([['tap-key-1', 3], ['tap-key-1', 3], ['tap-key-2', 2]]);
  });

  it('no weeks (an older API) sends none', async () => {
    const { session, transport } = setup(null);
    session.activate();
    await session.pay();
    expect(transport.start).toHaveBeenCalledWith('tap-key-1', undefined);
    expect(transport.open).toHaveBeenCalledWith('https://mmg.example/pay');
  });

  it('another open MMG payment for a different amount: said plainly, and the fee is read again', async () => {
    const { session, transport, views } = setup({ status: 409, code: 'CHECKOUT_OPEN_OTHER_AMOUNT' });
    session.activate();
    await session.pay(2);
    expect(views.at(-1)?.error).toBe('Another MMG payment is already open. Finish it, or wait until it closes, then choose again.');
    expect(transport.refresh).toHaveBeenCalled();
  });
});
