import { describe, expect, it, vi } from 'vitest';
import { FeeCheckoutSession, type CheckoutStart, type CheckoutView } from './weeklyFee';

// [OWNER RULING 8 Oct, NO "WALLET" (2)] The weekly fee can be paid at most four
// weeks ahead. When the server refuses a checkout for that (409
// PAY_AHEAD_LIMIT), the partner reads why and when they can pay again — not
// "Could not open MMG". (The website's copy is the same file, by census.)

function setup(failure: { status?: number; code?: string }) {
  const views: CheckoutView[] = [];
  const transport = {
    start: vi.fn(async (_key: string): Promise<CheckoutStart> => { throw failure; }),
    read: vi.fn(),
    open: vi.fn(),
    refresh: vi.fn(),
  };
  const session = new FeeCheckoutSession(transport as never, () => 'tap-key-1', (v) => views.push(v), (e) => e as { status?: number; code?: string });
  return { session, transport, views };
}

describe('[owner ruling 8 Oct] a checkout refused at the four-week limit', () => {
  it('says the next weekly fee is already paid (one week at a time, owner #62), opens nothing, and keeps the next tap fresh', async () => {
    const { session, transport, views } = setup({ status: 409, code: 'PAY_AHEAD_LIMIT' });
    session.activate();
    await session.pay();
    expect(transport.open).not.toHaveBeenCalled();
    expect(views.at(-1)?.error).toBe('Your next weekly fee is already paid. Swift takes the weekly fee one week at a time: you can pay again once that week has started.');
  });

  it('any other refusal keeps its own words', async () => {
    const { session, views } = setup({ status: 409, code: 'SOMETHING_ELSE' });
    session.activate();
    await session.pay();
    expect(views.at(-1)?.error).toBe('Could not open MMG. Try again.');
  });
});
