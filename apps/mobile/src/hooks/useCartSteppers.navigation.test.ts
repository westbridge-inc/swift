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
// and the latest is sent after the cart has been read again; a refusal shows what the server holds. The REAL hook in a
// real React renderer; the cart writes are stand-ins that answer when the test says, and a "cart read" is a re-render
// with the server's lines and a new read time (the cart query's dataUpdatedAt).
// ---------------------------------------------------------------------------

const fx = vi.hoisted(() => ({ calls: [] as Array<{ kind: 'add' | 'set'; body: Record<string, unknown>; ok: () => void; fail: () => void }> }));
vi.mock('./customer', () => {
  const out = (kind: 'add' | 'set') => (body: Record<string, unknown>) => new Promise((resolve, reject) => {
    fx.calls.push({ kind, body, ok: () => resolve({}), fail: () => reject(new Error('refused')) });
  });
  return {
    useAddToCart: () => ({ mutateAsync: out('add') }),
    useUpdateCartItem: () => ({ mutateAsync: out('set') }),
  };
});

import { useCartSteppers } from './useCartSteppers';

const h = React.createElement;
type Line = { id: string; itemId: string; quantity: number };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let api: ReturnType<typeof useCartSteppers>;
let server: Line[];
let readAt: number;

function Probe() {
  api = useCartSteppers(readAt);
  const shown = ['rice', 'oil'].map((itemId) => `${itemId}=${api.qty(itemId, server.find((l) => l.itemId === itemId))}`).join(' ');
  return h('span', null, `${shown} ${api.settled ? 'settled' : 'pending'}`);
}
const draw = async () => { await act(async () => root.render(h(Probe))); };
/** The cart is read again: the server's lines, a new read time. */
const read = async (lines: Line[]) => { server = lines; readAt += 1; await draw(); };
const tap = async (itemId: string, next: number) => {
  await act(async () => { api.set(itemId, server.find((l) => l.itemId === itemId), next, { vendorId: 'store-1', itemId }); });
};
const plus = async (itemId: string) => tap(itemId, api.qty(itemId, server.find((l) => l.itemId === itemId)) + 1);
const answer = async (i: number, how: 'ok' | 'fail' = 'ok') => { await act(async () => { fx.calls[i]![how](); await new Promise((r) => setTimeout(r, 0)); }); };
const shown = () => host.textContent;

beforeEach(async () => {
  fx.calls = [];
  server = [{ id: 'line-rice', itemId: 'rice', quantity: 1 }];
  readAt = 1;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await draw();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[TAP-AUDIT] the cart\'s + and −', () => {
  it('the number moves at the tap; three quick + from 1 end at 4 (none lost); one request at a time for the line', async () => {
    expect(shown()).toBe('rice=1 oil=0 settled');
    await plus('rice');
    expect(shown()).toBe('rice=2 oil=0 pending');
    await plus('rice');
    await plus('rice');
    expect(shown()).toBe('rice=4 oil=0 pending');
    expect(fx.calls.map((c) => [c.kind, c.body])).toEqual([['set', { id: 'line-rice', quantity: 2 }]]);
    await answer(0);
    // Answered, but the cart has not been read again: nothing is built from a quantity the screen has not seen.
    expect(fx.calls).toHaveLength(1);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 2 }]);
    expect(fx.calls.map((c) => [c.kind, c.body])).toEqual([['set', { id: 'line-rice', quantity: 2 }], ['set', { id: 'line-rice', quantity: 4 }]]);
    expect(shown()).toBe('rice=4 oil=0 pending');
    await answer(1);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 4 }]);
    expect(shown()).toBe('rice=4 oil=0 settled');
    expect(fx.calls).toHaveLength(2);
  });

  it('only that line waits: another item\'s + goes out at once', async () => {
    await plus('rice');
    await plus('oil');
    expect(fx.calls.map((c) => [c.kind, c.body])).toEqual([
      ['set', { id: 'line-rice', quantity: 2 }],
      ['add', { vendorId: 'store-1', itemId: 'oil', quantity: 1 }],
    ]);
    expect(shown()).toBe('rice=2 oil=1 pending');
  });

  it('an item not in the cart: the first + adds it; taps while it adds are sent once the cart shows the line', async () => {
    await plus('oil');
    await plus('oil');
    expect(fx.calls.map((c) => [c.kind, c.body])).toEqual([['add', { vendorId: 'store-1', itemId: 'oil', quantity: 1 }]]);
    expect(shown()).toBe('rice=1 oil=2 pending');
    await answer(0);
    await read([...server, { id: 'line-oil', itemId: 'oil', quantity: 1 }]);
    expect(fx.calls.map((c) => [c.kind, c.body])[1]).toEqual(['set', { id: 'line-oil', quantity: 2 }]);
    await answer(1);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 1 }, { id: 'line-oil', itemId: 'oil', quantity: 2 }]);
    expect(shown()).toBe('rice=1 oil=2 settled');
  });

  it('a + after an add answered but before the cart is read again sends nothing yet (the server adds to a line: sending again would count it twice)', async () => {
    await plus('oil');
    await answer(0); // the server now holds 1 oil, but the screen has not seen the line
    await plus('oil');
    expect(shown()).toBe('rice=1 oil=2 pending');
    expect(fx.calls).toHaveLength(1);
    await read([...server, { id: 'line-oil', itemId: 'oil', quantity: 1 }]);
    expect(fx.calls.map((c) => [c.kind, c.body])[1]).toEqual(['set', { id: 'line-oil', quantity: 2 }]);
  });

  it('− to zero takes the line out', async () => {
    await tap('rice', 0);
    expect(shown()).toBe('rice=0 oil=0 pending');
    expect(fx.calls.map((c) => [c.kind, c.body])).toEqual([['set', { id: 'line-rice', quantity: 0 }]]);
    await answer(0);
    await read([]);
    expect(shown()).toBe('rice=0 oil=0 settled');
  });

  it('a refused tap shows what the server holds (the app-wide notice says why)', async () => {
    await plus('rice');
    expect(shown()).toBe('rice=2 oil=0 pending');
    await answer(0, 'fail');
    expect(shown()).toBe('rice=1 oil=0 settled');
  });

  it('nothing to send when the tap lands where the server already is', async () => {
    await tap('rice', 1);
    expect(fx.calls).toHaveLength(0);
    await read(server);
    expect(shown()).toBe('rice=1 oil=0 settled');
  });

  it('never more than 99, never below 0', async () => {
    await tap('rice', 250);
    expect(fx.calls[0]!.body).toEqual({ id: 'line-rice', quantity: 99 });
    await answer(0);
    await read([{ id: 'line-rice', itemId: 'rice', quantity: 99 }]);
    await tap('rice', -3);
    expect(fx.calls[1]!.body).toEqual({ id: 'line-rice', quantity: 0 });
  });
});
