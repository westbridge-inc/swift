/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// The renderer is resolved to the workspace's existing web dependency by Vitest.
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { FARE_BREAKDOWN, riderRideWithStops, riderRideWithoutStops } from '../../lib/taxiContract.fixtures';

// ---------------------------------------------------------------------------
// [TAXI waiting charge · CONTRACT Rev 2 §8.4 · multi-stop] The REAL post-trip
// sheet. With the server's breakdown the receipt itemises "Trip", "Waiting N
// min" and the total — and the amount the passenger pays (cash or the driver's
// MMG link) is that total. Without one, it is today's single fare.
// ---------------------------------------------------------------------------

vi.mock('react-native', async () => {
  const R = await import('react');
  const h = R.createElement;
  return { View: (p: any) => h('div', { 'data-testid': p.testID }, p.children), Linking: { openURL: vi.fn() } };
});
vi.mock('../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const T = (p: any) => h('span', null, p.children);
  return {
    T, PopupTitle: T, IconChip: () => null, Stars: () => null,
    PopupCard: (p: any) => (p.visible ? h('div', { role: 'dialog' }, p.children) : null),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress }, p.label),
  };
});
vi.mock('../../hooks/customer', () => ({ useRateOrder: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock('../../stores/authStore', () => ({ AuthSessionBoundaryError: class extends Error {}, requireAuthSessionSnapshot: vi.fn() }));

import { RidePostTripSheet } from './RidePostTripSheet';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const snap = (name: string) => (globalThis as { __msCapture?: (n: string, html: string) => void }).__msCapture?.(name, host.innerHTML);
async function draw(ride: unknown) {
  await act(async () => root.render(React.createElement(RidePostTripSheet, { ride, onDone: vi.fn() })));
}
const text = () => host.textContent ?? '';

beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the receipt', () => {
  it('itemises the trip, the waiting and the total when the server sends the breakdown', async () => {
    await draw(riderRideWithoutStops({ taxiFareTotal: 2800, fareBreakdown: FARE_BREAKDOWN, driver: { user: { firstName: 'Devon' }, mmgPayUrl: 'https://pay.example.gy/devon' } }));
    snap('rider-receipt-waiting');
    const lines = host.querySelector('[data-testid="taxi-receipt-breakdown"]')?.textContent ?? '';
    expect(lines).toMatch(/Trip\$2.?800/);
    expect(lines).toMatch(/Waiting 13 min\$500/);
    expect(text()).toMatch(/\$3.?300 · cash · paid to Devon/);
    expect(text()).toMatch(/Total/);
    // The MMG link asks for the whole amount, never the route fare alone.
    expect(text()).toMatch(/Pay \$3.?300 with MMG instead/);
  });

  it('without a breakdown it is today’s single fare', async () => {
    await draw(riderRideWithoutStops({ taxiFareTotal: 2400 }));
    expect(host.querySelector('[data-testid="taxi-receipt-breakdown"]')).toBeNull();
    expect(text()).toMatch(/\$2.?400 · cash · paid to Devon/);
    expect(text()).not.toMatch(/Waiting|Total/);
  });

  it('lists the trip’s stops on the route, in order', async () => {
    await draw(riderRideWithStops());
    const all = text();
    expect(all).toContain('Stop 1: Camp Street');
    expect(all).toContain('Stop 2: Sheriff Street');
    expect(all.indexOf('Stop 1: Camp Street')).toBeLessThan(all.indexOf('Stop 2: Sheriff Street'));
  });
});

describe('[review 2] without a breakdown the receipt is main’s, byte for byte', () => {
  it('a finished ride, no stops, no waiting fields', async () => {
    await draw(riderRideWithoutStops({ taxiFareTotal: 2400 }));
    await expect(host.innerHTML).toMatchFileSnapshot('./__flagoff__/rider-receipt.html');
  });
});
