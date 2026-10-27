/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct · owner: "every single button tap"] The cart's + and − on the store page and in the cart.
//
// Before: one add or +/− disabled EVERY + on the page until the write answered; the number moved only after the write
// AND the cart's re-quote (~1.3 s on a mobile link); and a + tapped after the write answered but before the re-quote
// landed sent the OLD quantity again — 1, +, + ended at 2, not 3 (the tap was lost).
//
// Now (hooks/useCartSteppers): the number shows what was tapped at once; only that line has a request out; taps add up
// and the next request is built from the write's own answer (the API answers with the whole cart); a refusal shows
// what the server holds. [REVIEW-F #2145 S4-1/S4-2] The server's quantity is believed, never argued with; ONE stepper
// per line for the store page and the cart, which keeps going when a screen closes, and the cart's Place order waits
// for every line's taps. The REAL hook in a real React renderer, a store page and a cart side by side; the cart writes
// are stand-ins that answer when the test says; a "cart read" is a re-render with the server's lines and a new read time.
// ---------------------------------------------------------------------------

type Line = { id: string; itemId: string; quantity: number };
const fx = vi.hoisted(() => ({
  calls: [] as Array<{ kind: 'add' | 'set'; body: Record<string, unknown>; ok: (_answer?: unknown) => void; fail: () => void }>,
  refetch: vi.fn(),
}));
vi.mock('./customer', () => {
  const out = (kind: 'add' | 'set') => (body: Record<string, unknown>) => new Promise((resolve, reject) => {
    fx.calls.push({ kind, body, ok: (answer) => resolve(answer), fail: () => reject(new Error('refused')) });
  });
  return {
    useAddToCart: () => ({ mutateAsync: out('add') }),
    useUpdateCartItem: () => ({ mutateAsync: out('set') }),
  };
});
vi.mock('../stores/authStore', () => ({ useAuthStore: (select: (_s: { sessionGeneration: number }) => unknown) => select({ sessionGeneration: 1 }) }));

import { forgetCartSteppers, useCartSteppers } from './useCartSteppers';

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let store: ReturnType<typeof useCartSteppers>;
let cartPage: ReturnType<typeof useCartSteppers>;
let server: Line[];
let readAt: number;
let showCart: boolean;
let showStore: boolean;

const cartQuery = () => ({ data: { items: server }, dataUpdatedAt: readAt, refetch: fx.refetch });
const lineOf = (itemId: string) => server.find((l) => l.itemId === itemId);
function StorePage() {
  store = useCartSteppers(cartQuery());
  const shown = ['rice', 'oil'].map((itemId) => `${itemId}=${store.qty(itemId, lineOf(itemId))}`).join(' ');
  return h('p', { 'data-page': 'store' }, shown);
}
function CartPage() {
  cartPage = useCartSteppers(cartQuery());
  return h('p', { 'data-page': 'cart' }, `${server.map((l) => `${l.id}=${cartPage.qty(`line:${l.id}`, l)}`).join(' ')} ${cartPage.settled ? 'settled' : 'pending'}`);
}
const draw = async () => { await act(async () => root.render(h('div', null, showStore ? h(StorePage) : null, showCart ? h(CartPage) : null))); };
const page = (name: string) => host.querySelector(`[data-page="${name}"]`)?.textContent;
/** The cart is read again (after every answer so far): the server's lines, a new read time. */
const read = async (lines: Line[] = server) => { server = lines; readAt = Date.now() + 1000; await draw(); };
const tap = async (itemId: string, next: number) => {
  await act(async () => { store.set(itemId, lineOf(itemId), next, { vendorId: 'store-1', itemId }); });
};
const plus = async (itemId: string) => tap(itemId, store.qty(itemId, lineOf(itemId)) + 1);
/** The write answers with the whole cart (as POST/PUT /cart/items do); the screens have not read it yet. */
const answer = async (i: number, lines: Line[] | 'not-a-cart') => {
  await act(async () => { fx.calls[i]!.ok(lines === 'not-a-cart' ? { message: 'ok' } : { cart: { items: lines }, message: 'ok' }); await new Promise((r) => setTimeout(r, 0)); });
};
const refuse = async (i: number) => { await act(async () => { fx.calls[i]!.fail(); await new Promise((r) => setTimeout(r, 0)); }); };
const sent = () => fx.calls.map((c) => [c.kind, c.body]);

beforeEach(async () => {
  forgetCartSteppers();
  fx.calls = [];
  fx.refetch.mockReset();
  server = [{ id: 'line-rice', itemId: 'rice', quantity: 1 }];
  readAt = 1;
  showStore = true;
  showCart = false;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await draw();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[TAP-AUDIT] the cart\'s + and −', () => {
  it('three quick + from 1 end at 4: the number moves at the tap, one request out, the next built from its answer', async () => {
    expect(page('store')).toBe('rice=1 oil=0');
    await plus('rice');
    await plus('rice');
    await plus('rice');
    expect(page('store')).toBe('rice=4 oil=0');
    expect(sent()).toEqual([['set', { id: 'line-rice', quantity: 2 }]]);
    await answer(0, [{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    expect(sent()[1], 'no cart read needed: the answer says where the line is').toEqual(['set', { id: 'line-rice', quantity: 4 }]);
    await answer(1, [{ id: 'line-rice', itemId: 'rice', quantity: 4 }]);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 4 }]);
    expect(page('store')).toBe('rice=4 oil=0');
    expect(fx.calls).toHaveLength(2);
  });

  it('only that line waits: another item\'s + goes out at once', async () => {
    await plus('rice');
    await plus('oil');
    expect(sent()).toEqual([['set', { id: 'line-rice', quantity: 2 }], ['add', { vendorId: 'store-1', itemId: 'oil', quantity: 1 }]]);
    expect(page('store')).toBe('rice=2 oil=1');
  });

  it('an item not in the cart: + adds it; a + while it adds sets the new line from the answer (never a second add)', async () => {
    await plus('oil');
    await plus('oil');
    expect(sent()).toEqual([['add', { vendorId: 'store-1', itemId: 'oil', quantity: 1 }]]);
    await answer(0, [...server, { id: 'line-oil', itemId: 'oil', quantity: 1 }]);
    expect(sent()[1]).toEqual(['set', { id: 'line-oil', quantity: 2 }]);
    expect(page('store'), 'still found by item before the read').toBe('rice=1 oil=2');
  });

  it('− to zero takes the line out', async () => {
    await tap('rice', 0);
    expect(page('store')).toBe('rice=0 oil=0');
    expect(sent()).toEqual([['set', { id: 'line-rice', quantity: 0 }]]);
    await answer(0, []);
    await read([]);
    expect(page('store')).toBe('rice=0 oil=0');
  });

  it('a refused tap shows what the server holds, asks for the cart again, and a tap meanwhile goes from that read', async () => {
    await plus('rice');
    await refuse(0);
    expect(page('store')).toBe('rice=1 oil=0');
    expect(fx.refetch).toHaveBeenCalled();
    await plus('rice');
    expect(fx.calls, 'nothing is built from an unconfirmed number').toHaveLength(1);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 1 }]);
    expect(sent()[1]).toEqual(['set', { id: 'line-rice', quantity: 2 }]);
  });

  it('[REVIEW-F #2145 S4-1] the server keeps a different quantity: its number shows, and nothing is sent again', async () => {
    await plus('rice');
    await answer(0, [{ id: 'line-rice', itemId: 'rice', quantity: 1 }]);
    expect(page('store')).toBe('rice=1 oil=0');
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 1 }]);
    await read();
    expect(fx.calls).toHaveLength(1);
  });

  it('an answer that is not a cart: the next tap waits for a read (an add is never sent twice)', async () => {
    await plus('oil');
    await answer(0, 'not-a-cart');
    await plus('oil');
    expect(fx.calls).toHaveLength(1);
    await read([...server, { id: 'line-oil', itemId: 'oil', quantity: 1 }]);
    expect(sent()[1]).toEqual(['set', { id: 'line-oil', quantity: 2 }]);
  });

  it('a read that came before the answer does not settle the line', async () => {
    showCart = true;
    await draw();
    await plus('rice');
    await answer(0, [{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    readAt = 2; // a read from before the answer
    await draw();
    expect(page('cart')).toBe('line-rice=2 pending');
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    expect(page('cart')).toBe('line-rice=2 settled');
  });

  it('never more than 99, never below 0', async () => {
    await tap('rice', 250);
    expect(fx.calls[0]!.body).toEqual({ id: 'line-rice', quantity: 99 });
    await answer(0, [{ id: 'line-rice', itemId: 'rice', quantity: 99 }]);
    await tap('rice', -3);
    expect(fx.calls[1]!.body).toEqual({ id: 'line-rice', quantity: 0 });
  });
});

describe('[REVIEW-F #2145 S4-2] one stepper per line for the store page and the cart', () => {
  beforeEach(async () => { showCart = true; await draw(); });

  it('both show the same number at the tap, and a cart tap while the store page\'s request is out never crosses it', async () => {
    await plus('rice');
    expect(page('cart')).toBe('line-rice=2 pending');
    await act(async () => { cartPage.set('line:line-rice', server[0], cartPage.qty('line:line-rice', server[0]) + 1); });
    expect(page('store')).toBe('rice=3 oil=0');
    expect(sent(), 'one request for the line at a time').toEqual([['set', { id: 'line-rice', quantity: 2 }]]);
    await answer(0, [{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    expect(sent()[1]).toEqual(['set', { id: 'line-rice', quantity: 3 }]);
    await answer(1, [{ id: 'line-rice', itemId: 'rice', quantity: 3 }]);
    expect(fx.calls).toHaveLength(2);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 3 }]);
    expect(page('cart')).toBe('line-rice=3 settled');
  });

  it('an item added on the store page is the same line in the cart as soon as the cart shows it', async () => {
    await plus('oil');
    await plus('oil');
    await answer(0, [...server, { id: 'line-oil', itemId: 'oil', quantity: 1 }]);
    expect(sent()[1]).toEqual(['set', { id: 'line-oil', quantity: 2 }]);
    await read([...server, { id: 'line-oil', itemId: 'oil', quantity: 1 }]); // read while the set is out
    expect(page('cart')).toBe('line-rice=1 line-oil=2 pending');
    expect(page('store')).toBe('rice=1 oil=2');
  });

  it('the cart\'s Place order waits for a tap still out from the store page', async () => {
    await plus('rice');
    expect(cartPage.settled).toBe(false);
    await answer(0, [{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    expect(cartPage.settled, 'until the cart is read again').toBe(false);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    expect(cartPage.settled).toBe(true);
  });

  it('the store page closed with taps waiting: they still go (no screen needed), and the cart shows them', async () => {
    await plus('rice');
    await plus('rice');
    showStore = false;
    await draw();
    await answer(0, [{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    expect(sent()[1]).toEqual(['set', { id: 'line-rice', quantity: 3 }]);
    expect(page('cart')).toBe('line-rice=3 pending');
  });
});
