import { describe, expect, it, vi } from 'vitest';
import { FeeCheckoutSession, type CheckoutStart, type CheckoutView } from './weeklyFee';

// [OWNER 6 Nov 2026, up to four weeks ahead; replaces owner #62's one week] The
// weekly fee can be paid up to four weeks ahead: the partner picks 1 to 4 weeks
// from what the server says fits. When the server still refuses a checkout (409:
// the limit, something else filled the room, another MMG payment open), the
// partner reads the server's own words, which name what can be paid, and the
// fee is read again — not "Could not open MMG". (The website's copy is the same
// file, by census.)

function setup(failure: { status?: number; code?: string; message?: string } | null) {
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
  const session = new FeeCheckoutSession(transport as never, () => `tap-key-${++n}`, (v) => views.push(v), (e) => e as { status?: number; code?: string; message?: string });
  return { session, transport, views };
}

describe('[owner 6 Nov] a checkout refused at the four-week limit', () => {
  const LIMIT = 'Swift takes the weekly fee up to four weeks ahead. GY$4,200 is already paid toward weeks that have not started, so you can pay at most GY$4,200 now.';
  it('says the server’s words, opens nothing, reads the fee again, and keeps the next tap fresh', async () => {
    const { session, transport, views } = setup({ status: 409, code: 'PAY_AHEAD_LIMIT', message: LIMIT });
    session.activate();
    await session.pay(4);
    expect(transport.open).not.toHaveBeenCalled();
    expect(transport.refresh).toHaveBeenCalled();
    expect(views.at(-1)?.error).toBe(LIMIT);
    await session.pay(4);
    expect(transport.start.mock.calls.map((c) => c[0])).toEqual(['tap-key-14', 'tap-key-24']);
  });

  it('another open MMG payment for another amount: the server’s words, and the fee is read again', async () => {
    const { session, transport, views } = setup({ status: 409, code: 'CHECKOUT_OPEN_OTHER_AMOUNT', message: "An MMG payment of GY$8,400 is already open. Finish it on MMG's page, or wait until it closes, then choose again." });
    session.activate();
    await session.pay();
    expect(views.at(-1)?.error).toBe("An MMG payment of GY$8,400 is already open. Finish it on MMG's page, or wait until it closes, then choose again.");
    expect(transport.refresh).toHaveBeenCalled();
  });

  it('a refusal with no words, or any other failure, keeps its own words', async () => {
    const quiet = setup({ status: 409, code: 'SOMETHING_ELSE' });
    quiet.session.activate();
    await quiet.session.pay();
    expect(quiet.views.at(-1)?.error).toBe('Could not open MMG. Try again.');
    const down = setup({ status: 503, code: 'MMG_CHECKOUT_UNAVAILABLE' });
    down.session.activate();
    await down.session.pay();
    expect(down.views.at(-1)?.error).toBe('Try again in a minute.');
  });
});

describe('[owner 6 Nov] choosing how many weeks', () => {
  it('the weeks chosen go to the server; a retry of the same tap keeps its key, another choice is another key', async () => {
    const { session, transport } = setup({ status: 503, code: 'MMG_CHECKOUT_UNAVAILABLE' });
    session.activate();
    await session.pay(3);
    await session.pay(3);
    await session.pay(2);
    expect(transport.start.mock.calls).toEqual([['tap-key-13', 3], ['tap-key-13', 3], ['tap-key-12', 2]]);
  });

  it('no weeks (an older API) sends none, under the tap’s own key', async () => {
    const { session, transport } = setup(null);
    session.activate();
    await session.pay();
    expect(transport.start).toHaveBeenCalledWith('tap-key-1', undefined);
    expect(transport.open).toHaveBeenCalledWith('https://mmg.example/pay');
  });
});
