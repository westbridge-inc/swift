/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { useRowHold, type RowHold } from './useRowHold';

// ---------------------------------------------------------------------------
// [BUG-GUARDS C2 · #1952 review S3-2] useRowHold: only the SAME row waits.
// The real hook in a real React renderer. Asserted: rows hold independently;
// `busy` stays true until EVERY row has answered (two cart lines removing:
// the mutation's isPending follows only the latest call, so the cart's quote
// gate reads `busy`), and a row is released after a failure and after a
// throw inside run.
// ---------------------------------------------------------------------------

const h = React.createElement;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let hold: RowHold;
const pending: Record<string, { ok: () => void; fail: () => void }> = {};
let runs: string[] = [];

function Probe() {
  hold = useRowHold();
  return h('span', null, hold.busy ? 'busy' : 'idle');
}
const send = (key: string) => () => new Promise<void>((resolve, reject) => {
  runs.push(key);
  pending[key] = { ok: () => resolve(), fail: () => reject(new Error('down')) };
});
const press = async (key: string) => { let went = false; await act(async () => { went = hold(key, send(key)); }); return went; };
const answer = async (key: string, how: 'ok' | 'fail') => { await act(async () => { pending[key]![how](); await new Promise((r) => setTimeout(r, 0)); }); };
const shown = () => host.textContent;

beforeEach(async () => {
  runs = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(h(Probe)));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[BUG-GUARDS C2] useRowHold', () => {
  it('holds each row on its own, and stays busy until every row answered', async () => {
    expect(await press('a')).toBe(true);
    expect(await press('b')).toBe(true);
    expect(await press('a')).toBe(false);
    expect(runs).toEqual(['a', 'b']);
    expect(shown()).toBe('busy');
    await answer('b', 'ok'); // the LATER row answers first
    expect(shown()).toBe('busy');
    expect(await press('b')).toBe(true);
    await answer('b', 'ok');
    await answer('a', 'fail'); // a failure releases its row too
    expect(shown()).toBe('idle');
    expect(await press('a')).toBe(true);
    expect(runs).toEqual(['a', 'b', 'b', 'a']);
  });

  it('a throw inside run releases the row', async () => {
    await act(async () => {
      expect(() => hold('x', () => { throw new Error('boom'); })).toThrow('boom');
    });
    expect(shown()).toBe('idle');
    expect(await press('x')).toBe(true);
  });
});
