import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cart } from './customer';
import { answeredCart, cartTaps, itemHold, tapSend, type CartTapsIO, type TapSend } from './cart-taps';

// ---------------------------------------------------------------------------
// [TAP-AUDIT 27 Oct] The website store page's + and − (lib/cart-taps). The writes and reads are stand-ins that answer
// when the test says; each write answers with the whole cart, as POST/PUT/DELETE /cart/items do.
// ---------------------------------------------------------------------------

type Line = Cart['items'][number];
const line = (id: string, itemId: string, quantity: number, extra: Partial<Line> = {}) => ({ id, itemId, quantity, name: itemId, customerPrice: 100, ...extra }) as unknown as Line;
const cartOf = (...items: Line[]) => ({ items }) as unknown as Cart;

let sends: Array<{ itemId: string; request: TapSend; ok: (_answer: unknown) => void; fail: (_error: unknown) => void }>;
let reads: Array<{ ok: (_cart: Cart) => void; fail: (_error: unknown) => void }>;
let shown: Cart[];
let failures: unknown[];
let added: string[];
let taps: ReturnType<typeof cartTaps>;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  sends = []; reads = []; shown = []; failures = []; added = [];
  const io: CartTapsIO = {
    send: (itemId, request) => new Promise((ok, fail) => { sends.push({ itemId, request, ok, fail }); }),
    read: () => new Promise((ok, fail) => { reads.push({ ok, fail }); }),
    show: (cart) => { shown.push(cart); },
    changed: () => {},
    failed: (error) => { failures.push(error); },
    added: (name) => { added.push(name); },
  };
  taps = cartTaps(() => io);
  taps.live(true);
});
const answer = async (i: number, cart: Cart | null) => { sends[i]!.ok({ cart, message: 'ok' }); await flush(); };
const read = async (i: number, cart: Cart) => { reads[i]!.ok(cart); await flush(); };

describe('[TAP-AUDIT] the website\'s + and −', () => {
  it('three quick + from 1 end at 4: the number moves at the tap, one request out, the next built from the answer (no read in between)', async () => {
    const now = cartOf(line('l-rice', 'rice', 1));
    taps.tap('rice', 'Rice', 1, now);
    taps.tap('rice', 'Rice', 1, now);
    taps.tap('rice', 'Rice', 1, now);
    expect(taps.shown('rice', 1)).toBe(4);
    expect(sends.map((s) => s.request)).toEqual([{ kind: 'set', lineId: 'l-rice', quantity: 2 }]);
    await answer(0, cartOf(line('l-rice', 'rice', 2)));
    expect(sends.map((s) => s.request)[1]).toEqual({ kind: 'set', lineId: 'l-rice', quantity: 4 });
    expect(reads).toHaveLength(0);
    await answer(1, cartOf(line('l-rice', 'rice', 4)));
    expect(reads).toHaveLength(1);
    expect(taps.pending(), 'Checkout waits for the read').toBe(true);
    await read(0, cartOf(line('l-rice', 'rice', 4)));
    expect(taps.pending()).toBe(false);
    expect(taps.shown('rice', 4)).toBe(4);
    expect(sends).toHaveLength(2);
  });

  it('only that item waits: another item\'s + goes out at once', () => {
    taps.tap('rice', 'Rice', 1, cartOf(line('l-rice', 'rice', 1)));
    taps.tap('oil', 'Oil', 1, cartOf(line('l-rice', 'rice', 1)));
    expect(sends.map((s) => [s.itemId, s.request])).toEqual([
      ['rice', { kind: 'set', lineId: 'l-rice', quantity: 2 }],
      ['oil', { kind: 'add', quantity: 1 }],
    ]);
    expect(taps.blocked('oil')).toBe(false);
  });

  it('an item not in the cart: + adds it; a + while it adds sets the new line from the answer (never a second add)', async () => {
    taps.tap('oil', 'Oil', 1, cartOf());
    taps.tap('oil', 'Oil', 1, cartOf());
    expect(sends.map((s) => s.request)).toEqual([{ kind: 'add', quantity: 1 }]);
    await answer(0, cartOf(line('l-oil', 'oil', 1)));
    expect(sends.map((s) => s.request)[1]).toEqual({ kind: 'set', lineId: 'l-oil', quantity: 2 });
    expect(added, 'an answered increase says so').toEqual(['Oil']);
  });

  it('− to zero takes the line out', async () => {
    taps.tap('rice', 'Rice', -1, cartOf(line('l-rice', 'rice', 1)));
    expect(taps.shown('rice', 1)).toBe(0);
    expect(sends.map((s) => s.request)).toEqual([{ kind: 'remove', lineId: 'l-rice' }]);
    await answer(0, null);
    await read(0, cartOf());
    expect(taps.pending()).toBe(false);
  });

  it('[REVIEW-F #2145 S4-1] the server keeps a different quantity: believed, never sent again', async () => {
    taps.tap('rice', 'Rice', 1, cartOf(line('l-rice', 'rice', 1)));
    await answer(0, cartOf(line('l-rice', 'rice', 1))); // the server kept 1
    expect(sends).toHaveLength(1);
    await read(0, cartOf(line('l-rice', 'rice', 1)));
    expect(taps.shown('rice', 1)).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it('a refused tap: the cart\'s number shows again, the item waits for the read, and the words say why', async () => {
    taps.tap('rice', 'Rice', 1, cartOf(line('l-rice', 'rice', 1)));
    sends[0]!.fail(new Error('Only 1 left.'));
    await flush();
    expect(failures).toEqual([new Error('Only 1 left.')]);
    expect(taps.shown('rice', 1)).toBe(1);
    expect(taps.blocked('rice'), 'nothing is built from an unconfirmed number').toBe(true);
    taps.tap('rice', 'Rice', 1, cartOf(line('l-rice', 'rice', 1)));
    expect(sends).toHaveLength(1);
    await read(0, cartOf(line('l-rice', 'rice', 1)));
    expect(taps.blocked('rice')).toBe(false);
  });

  it('an answer that is not a cart: the next tap waits for a read (an add is never sent twice)', async () => {
    taps.tap('oil', 'Oil', 1, cartOf());
    sends[0]!.ok({ message: 'ok' });
    await flush();
    expect(taps.blocked('oil')).toBe(true);
    taps.tap('oil', 'Oil', 1, cartOf());
    expect(sends).toHaveLength(1);
    await read(0, cartOf(line('l-oil', 'oil', 1)));
    expect(taps.blocked('oil')).toBe(false);
    taps.tap('oil', 'Oil', 1, cartOf(line('l-oil', 'oil', 1)));
    expect(sends.map((s) => s.request)[1]).toEqual({ kind: 'set', lineId: 'l-oil', quantity: 2 });
  });

  it('a read that started before an item\'s answer does not settle it', async () => {
    taps.tap('rice', 'Rice', 1, cartOf(line('l-rice', 'rice', 1)));
    taps.tap('oil', 'Oil', 1, cartOf());
    await answer(0, cartOf(line('l-rice', 'rice', 2))); // rice done: a read starts while oil is still out
    expect(reads).toHaveLength(1);
    await answer(1, cartOf(line('l-rice', 'rice', 2), line('l-oil', 'oil', 1)));
    await read(0, cartOf(line('l-rice', 'rice', 2)));
    expect(taps.busy('rice')).toBe(false);
    expect(taps.busy('oil'), 'oil waits for a read that includes its answer').toBe(true);
    expect(reads).toHaveLength(2);
    await read(1, cartOf(line('l-rice', 'rice', 2), line('l-oil', 'oil', 1)));
    expect(taps.pending()).toBe(false);
  });

  it('a cart that cannot be read: said, and read again shortly; nothing settles from it', async () => {
    vi.useFakeTimers();
    try {
      taps.tap('rice', 'Rice', 1, cartOf(line('l-rice', 'rice', 1)));
      sends[0]!.ok({ cart: cartOf(line('l-rice', 'rice', 2)) });
      await vi.advanceTimersByTimeAsync(0);
      reads[0]!.fail(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      expect(failures).toEqual([new Error('offline')]);
      expect(taps.pending()).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(reads).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('a change that is not a tap (an add with choices, a ×) holds only that item until the cart is read again', async () => {
    let done!: () => void;
    const held = taps.hold('curry', 'Curry', () => new Promise<void>((r) => { done = r; }));
    expect(taps.busy('curry')).toBe(true);
    expect(taps.blocked('curry')).toBe(true);
    expect(taps.busy('rice')).toBe(false);
    done();
    expect(await held).toBe(true);
    expect(taps.busy('curry'), 'until the read').toBe(true);
    await read(0, cartOf(line('l-curry', 'curry', 1, { selectedOptionNames: ['Large'] } as Partial<Line>)));
    expect(taps.busy('curry')).toBe(false);
  });

  it('never below 0; a plain line never above 99 (the server\'s cap)', () => {
    taps.tap('rice', 'Rice', -1, cartOf());
    expect(sends).toHaveLength(0);
    expect(taps.pending()).toBe(false);
    taps.tap('rice', 'Rice', 1, cartOf(line('l-rice', 'rice', 99)));
    expect(sends).toHaveLength(0);
  });
});

describe('[TAP-AUDIT] the request for a tapped total', () => {
  it('sets the plain line, takes it out at zero, adds the plain item when the item has only chosen lines, and never takes from a chosen line', () => {
    const plain = itemHold(cartOf(line('l', 'x', 2)), 'x');
    expect(tapSend(3, plain)).toEqual({ kind: 'set', lineId: 'l', quantity: 3 });
    expect(tapSend(0, plain)).toEqual({ kind: 'remove', lineId: 'l' });
    const chosen = itemHold(cartOf(line('c', 'x', 2, { selectedOptionNames: ['Large'] } as Partial<Line>)), 'x');
    expect(chosen.line).toBeNull();
    expect(tapSend(3, chosen)).toEqual({ kind: 'add', quantity: 1 });
    expect(tapSend(1, chosen)).toBeNull();
  });

  it('reads the cart out of a write\'s answer, with or without the envelope', () => {
    const cart = cartOf(line('l', 'x', 1));
    expect(answeredCart({ cart, message: 'ok' })).toBe(cart);
    expect(answeredCart({ success: true, data: { cart, message: 'ok' } })).toBe(cart);
    expect(answeredCart({ success: true, data: { cart: null } })).toBeNull();
    expect(answeredCart(cart)).toBeUndefined();
    expect(answeredCart({ cart: { nope: true } })).toBeUndefined();
  });
});
