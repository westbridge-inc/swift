/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error The workspace web install supplies the test renderer.
import { createRoot } from 'react-dom/client';

// [promo-film finding 2 Nov 2026] The cash offer card, rendered: a store order names the store and its share; a taxi
// ride or a courier job (the server's cash math pays no store) never says "Pay the store $0".
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  return { View: (p: any) => h('div', null, p.children) };
});
vi.mock('@swift/ui', () => ({ color: { surface: { subtle: 'subtle' } }, radius: { md: 8 }, space: { md: 12 } }));
vi.mock('../../../kit', async () => {
  const { createElement: h } = await import('react');
  return { T: (p: any) => h('p', null, p.children) };
});

import { OfferCashMath } from './OfferCashMath';

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; });
async function render(props: React.ComponentProps<typeof OfferCashMath>) {
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(React.createElement(OfferCashMath, props)));
  return [...host.querySelectorAll('p')].map((p) => p.textContent?.replace(/\s+/g, ' ').trim());
}

describe('the cash offer card names a store only when one is owed', () => {
  it('a store order (store share > 0): collect, then pay the store its share and what you keep', async () => {
    const lines = await render({ cashMath: { collectFromCustomer: 5200, payToVendor: 4200, youKeep: 1000 }, vendorName: 'Sample Kitchen' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Cash job — collect .*5,200 from the customer$/);
    expect(lines[1]).toMatch(/^Pay Sample Kitchen .*4,200 · you keep .*1,000$/);
  });

  it('a taxi ride or courier job (store share 0): collect, then what you keep; no store line', async () => {
    const lines = await render({ cashMath: { collectFromCustomer: 800, payToVendor: 0, youKeep: 800 } });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Cash job — collect .*800 from the customer$/);
    expect(lines[1]).toMatch(/^You keep .*800$/);
    expect(host.textContent).not.toMatch(/Pay |the store/);
  });

  it('no cash math (MMG, or a split the server could not reconcile): nothing', async () => {
    await render({ cashMath: null });
    expect(host.textContent).toBe('');
  });
});
