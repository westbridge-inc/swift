import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOLD_IN_STORE, SOLD_UNDO_MS, createSoldInStore, type SaleAnswer, type SaleOp, type SaleSender } from './inStoreSale';
import { phoneSaleFailure } from '../hooks/useSoldInStore';

// ---------------------------------------------------------------------------
// [IN-STORE-SALE] The line of "Sold in store −1" taps, shared by the phone and the website (pure, no network).
// The count moves at the tap; taps add up; one request at a time per item, each tap with its OWN key; only that item
// waits; nothing is lost and nothing is sent again by itself (a refusal says why; no answer offers "Try again", which
// resends the SAME keys); Undo takes back the newest tap (never sent: removed; sent: an undo naming its key).
// ---------------------------------------------------------------------------

type Call = { itemId: string; op: SaleOp; resolve: (a: SaleAnswer) => void; reject: (e: unknown) => void };
let calls: Call[];
let answered: Array<{ itemId: string; answer: SaleAnswer; scope: unknown }>;
let rereads: number;
let keys: number;
const NO_ANSWER = new Error('offline');
const refusal = (words: string) => Object.assign(new Error('409'), { words });

const senders = new WeakMap<object, SaleSender>();
const senderOf = (e: object) => senders.get(e)!;
function engine() {
  const e = createSoldInStore();
  const sender: SaleSender = {
    newKey: () => `tap-${++keys}`,
    send: (itemId, op) => new Promise<SaleAnswer>((resolve, reject) => { calls.push({ itemId, op, resolve, reject }); }),
    answered: (itemId, answer, scope) => { answered.push({ itemId, answer, scope }); },
    reread: () => { rereads += 1; },
    classify: (error) => ((error as { words?: string }).words ? { refused: (error as { words: string }).words } : 'noAnswer'),
  };
  e.setSender(sender);
  senders.set(e, sender);
  return e;
}
const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
const out = () => calls.filter((c) => !('done' in c));
function answer(call: Call, stock: number) { (call as Call & { done?: true }).done = true; call.resolve({ stockQuantity: stock, isAvailable: stock > 0 }); }
function fail(call: Call, error: unknown) { (call as Call & { done?: true }).done = true; call.reject(error); }

beforeEach(() => { vi.useFakeTimers(); calls = []; answered = []; rereads = 0; keys = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('[IN-STORE-SALE] Sold in store taps', () => {
  it('the count moves at the tap and settles on the server\'s answer', async () => {
    const e = engine();
    e.tap('rice', 'store-a');
    expect(e.shown('rice', 5)).toBe(4);
    expect(calls.map((c) => c.op)).toEqual([{ kind: 'sale', key: 'tap-1' }]);
    answer(calls[0]!, 4);
    await flush();
    expect(answered).toEqual([{ itemId: 'rice', answer: { stockQuantity: 4, isAvailable: true }, scope: 'store-a' }]);
    // The answer is the list's count now: nothing is left to take off it.
    expect(e.view('rice').pending).toBe(0);
    expect(e.shown('rice', 4)).toBe(4);
  });

  it('taps add up: one request at a time per item, each tap its own key, none lost', async () => {
    const e = engine();
    e.tap('rice');
    e.tap('rice');
    e.tap('rice');
    expect(e.shown('rice', 5)).toBe(2);
    expect(calls).toHaveLength(1);
    answer(calls[0]!, 4);
    await flush();
    expect(calls).toHaveLength(2);
    expect(e.shown('rice', 4)).toBe(2);
    answer(calls[1]!, 3);
    await flush();
    answer(calls[2]!, 2);
    await flush();
    expect(calls.map((c) => c.op)).toEqual([1, 2, 3].map((n) => ({ kind: 'sale', key: `tap-${n}` })));
    expect(e.view('rice')).toMatchObject({ pending: 0, unsent: 0 });
  });

  it('only that item waits: another item\'s tap goes out while the first is still on its way', () => {
    const e = engine();
    e.tap('rice');
    e.tap('oil');
    expect(out().map((c) => c.itemId)).toEqual(['rice', 'oil']);
    expect(e.shown('oil', 3)).toBe(2);
  });

  it('a refusal says why in the server\'s words, drops that item\'s waiting taps, and reads the list again', async () => {
    const e = engine();
    e.tap('rice');
    e.tap('rice');
    fail(calls[0]!, refusal(SOLD_IN_STORE.noneLeft));
    await flush();
    expect(calls).toHaveLength(1); // the waiting tap would be refused too: never sent
    expect(e.view('rice')).toMatchObject({ pending: 0, sold: 0, notice: SOLD_IN_STORE.noneLeft, stalled: false });
    expect(rereads).toBe(1);
    // A new tap clears the words.
    e.tap('rice');
    expect(e.view('rice').notice).toBeNull();
  });

  it('no answer keeps the taps (they may have landed) and never sends them again by itself; Try again resends the SAME keys', async () => {
    const e = engine();
    e.tap('rice');
    e.tap('rice');
    fail(calls[0]!, NO_ANSWER);
    await flush();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(calls).toHaveLength(1);
    expect(e.view('rice')).toMatchObject({ stalled: true, unsent: 2, pending: -2 });
    expect(e.shown('rice', 5)).toBe(3);
    expect(SOLD_IN_STORE.notSent(e.view('rice').unsentSales, e.view('rice').unsentUndos)).toBe("Swift hasn't confirmed 2 sales yet.");
    e.retry('rice');
    expect(calls.map((c) => c.op)).toEqual([{ kind: 'sale', key: 'tap-1' }, { kind: 'sale', key: 'tap-1' }]);
    answer(calls[1]!, 4);
    await flush();
    answer(calls[2]!, 3);
    await flush();
    expect(calls[2]!.op).toEqual({ kind: 'sale', key: 'tap-2' });
    expect(e.view('rice')).toMatchObject({ stalled: false, unsent: 0, pending: 0 });
  });

  it('"Sold 1 in store · Undo" shows for a short time after the last tap', async () => {
    const e = engine();
    e.tap('rice');
    answer(calls[0]!, 4);
    await flush();
    expect(e.view('rice').sold).toBe(1);
    e.tap('rice');
    expect(e.view('rice').sold).toBe(2);
    vi.advanceTimersByTime(SOLD_UNDO_MS - 1);
    expect(e.view('rice').sold).toBe(2);
    vi.advanceTimersByTime(1);
    expect(e.view('rice').sold).toBe(0);
    e.undo('rice'); // nothing left to undo once it has gone
    expect(calls.map((c) => c.op.kind)).toEqual(['sale', 'sale']);
  });

  it('Undo of a sent tap sends an undo naming that tap\'s key, after it, and the count goes back at once', async () => {
    const e = engine();
    e.tap('rice');
    answer(calls[0]!, 4);
    await flush();
    e.undo('rice');
    expect(e.shown('rice', 4)).toBe(5);
    expect(e.view('rice').sold).toBe(0);
    expect(calls[1]!.op).toEqual({ kind: 'undo', saleKey: 'tap-1' });
    answer(calls[1]!, 5);
    await flush();
    expect(e.view('rice').pending).toBe(0);
  });

  it('Undo while the tap is still on its way waits for it, then takes it back (never two requests at once)', async () => {
    const e = engine();
    e.tap('rice');
    e.undo('rice');
    expect(calls).toHaveLength(1);
    expect(e.shown('rice', 5)).toBe(5);
    answer(calls[0]!, 4);
    await flush();
    expect(calls[1]!.op).toEqual({ kind: 'undo', saleKey: 'tap-1' });
  });

  it('Undo of a tap never sent removes it: nothing goes to Swift for it', async () => {
    const e = engine();
    e.tap('rice');
    e.tap('rice'); // waits behind the first
    e.undo('rice');
    expect(e.shown('rice', 5)).toBe(4);
    expect(e.view('rice').sold).toBe(1);
    answer(calls[0]!, 4);
    await flush();
    expect(calls).toHaveLength(1);
    expect(e.view('rice')).toMatchObject({ pending: 0, unsent: 0 });
  });

  it('Undo of a tap that did not get an answer is sent as an undo after it (it may have landed), never just dropped', async () => {
    const e = engine();
    e.tap('rice');
    fail(calls[0]!, NO_ANSWER);
    await flush();
    e.undo('rice');
    expect(e.view('rice')).toMatchObject({ pending: 0, unsent: 2, stalled: true });
    e.retry('rice');
    answer(calls[1]!, 4);
    await flush();
    expect(calls[2]!.op).toEqual({ kind: 'undo', saleKey: 'tap-1' });
  });

  it('the shown count never goes below 0', () => {
    const e = engine();
    for (let i = 0; i < 3; i += 1) e.tap('rice');
    expect(e.shown('rice', 1)).toBe(0);
  });

  it('settles on the answer even when the list on screen draws a moment later (no flash of the count from before), then follows the list', async () => {
    const e = engine();
    e.tap('rice');
    expect(e.shown('rice', 5)).toBe(4);
    answer(calls[0]!, 4);
    await flush();
    // The answer is written into the list, but this row draws before the list does: still 4, never 5.
    expect(e.shown('rice', 5)).toBe(4);
    expect(e.shown('rice', 4)).toBe(4);
    // A later re-read is the truth (another till sold one): the row follows it.
    expect(e.shown('rice', 3)).toBe(3);
    expect(e.shown('rice', 3)).toBe(3);
  });

  it('a tap without a sender (nothing to send it) is not taken', () => {
    const e = createSoldInStore();
    e.tap('rice');
    expect(e.view('rice')).toMatchObject({ pending: 0, unsent: 0 });
  });

  it('a row\'s snapshot changes only with ITS item', () => {
    const e = engine();
    const before = e.viewKey('rice');
    e.tap('oil');
    expect(e.viewKey('rice')).toBe(before);
    e.tap('rice');
    expect(e.viewKey('rice')).not.toBe(before);
  });
});

// [REVIEW-F #2157] The reviewer's probes, lifted (P1-P6), and the store-switch park (S4-5).
describe('[IN-STORE-SALE · REVIEW-F #2157] the line under stress', () => {
  it('P1 an answer the row never drew, then a fresher list (another sale meanwhile): the row shows the list, not the old answer', async () => {
    const e = engine();
    expect(e.shown('rice', 5)).toBe(5);
    e.tap('rice');
    answer(calls[0]!, 4);
    await flush();
    expect(e.shown('rice', 3)).toBe(3);
  });

  it('P2 a refusal on the 3rd tap keeps Undo for the 2 taps that DID land', async () => {
    const e = engine();
    e.tap('oil'); e.tap('oil'); e.tap('oil');
    answer(calls[0]!, 1); await flush();
    answer(calls[1]!, 0); await flush();
    fail(calls[2]!, refusal(SOLD_IN_STORE.noneLeft)); await flush();
    expect(e.view('oil').notice).toBe(SOLD_IN_STORE.noneLeft);
    expect(e.view('oil').sold).toBe(2);
    e.undo('oil');
    expect(calls[3]!.op).toEqual({ kind: 'undo', saleKey: 'tap-2' });
  });

  it('P3 one sale and its Undo waiting for Try again are named as that, never "2 sales"; words never claim it did not land', async () => {
    const e = engine();
    e.tap('rice');
    fail(calls[0]!, NO_ANSWER); await flush();
    expect(SOLD_IN_STORE.notSent(e.view('rice').unsentSales, e.view('rice').unsentUndos)).toBe("Swift hasn't confirmed this sale yet.");
    e.undo('rice');
    const v = e.view('rice');
    expect(v.stalled).toBe(true);
    expect(SOLD_IN_STORE.notSent(v.unsentSales, v.unsentUndos)).toBe("Swift hasn't confirmed this sale or its Undo yet.");
    expect(SOLD_IN_STORE.notSent(0, 1)).toBe("Swift hasn't confirmed the Undo yet.");
  });

  it('P4 after reset (another person signed in) the last person\'s waiting tap is never sent, and the old answer is not written', async () => {
    const e = engine();
    e.tap('rice'); e.tap('rice');
    e.reset();
    const later: string[] = [];
    e.setSender({ newKey: () => 'b-key', send: async () => { later.push('sent'); return null; }, answered: () => { later.push('answered'); }, reread: () => undefined, classify: () => 'noAnswer' });
    answer(calls[0]!, 4); await flush();
    expect(later).toEqual([]);
    expect(answered).toEqual([]);
    expect(e.view('rice')).toMatchObject({ pending: 0, unsent: 0 });
  });

  it('P5 a new tap while stalled sends nothing by itself', async () => {
    const e = engine();
    e.tap('rice');
    fail(calls[0]!, NO_ANSWER); await flush();
    e.tap('rice'); await flush();
    expect(calls).toHaveLength(1);
    expect(e.view('rice')).toMatchObject({ stalled: true, unsent: 2, pending: -2 });
  });

  it('P6 a server error (5xx) or no response is "no answer" on the phone, never a refusal that drops the taps', () => {
    expect(phoneSaleFailure({ response: { status: 500, data: { error: { message: 'Internal' } } } })).toBe('noAnswer');
    expect(phoneSaleFailure({ response: { status: 503 } })).toBe('noAnswer');
    expect(phoneSaleFailure(new Error('Network Error'))).toBe('noAnswer');
    expect(phoneSaleFailure({ response: { status: 409, data: { error: { message: SOLD_IN_STORE.noneLeft } } } })).toEqual({ refused: SOLD_IN_STORE.noneLeft });
  });

  it('S4-5 a tap made in store A is never sent while store B is open: parked, then sent with Try again back in A', async () => {
    const e = engine();
    let open = 'store-a';
    e.setSender({ ...senderOf(e), canSend: (scope) => scope === open });
    e.tap('rice', 'store-a');
    e.tap('rice', 'store-a');
    open = 'store-b';
    answer(calls[0]!, 4); await flush();
    expect(calls).toHaveLength(1);
    expect(e.view('rice')).toMatchObject({ stalled: true, unsent: 1 });
    e.retry('rice'); await flush();
    expect(calls).toHaveLength(1); // still another store: still parked
    open = 'store-a';
    e.retry('rice'); await flush();
    expect(calls.map((c) => c.op)).toEqual([{ kind: 'sale', key: 'tap-1' }, { kind: 'sale', key: 'tap-2' }]);
  });
});
