/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
// @ts-expect-error react-dom is deliberately not a mobile runtime dependency.
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// [BUG-HUNT-2 G06] A ride that is over, through the REAL screen over a REAL query; only native drawing, the kit and the network are stand-ins.

const fx = vi.hoisted(() => ({
  ride: {} as Record<string, unknown>,
  rate: vi.fn((_body: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
  token: new Proxy({}, { get: (_target, key): unknown => key === Symbol.toPrimitive ? () => 0 : fx.token }),
}));

vi.mock('react-native', async () => {
  const R = await import('react');
  const View = (p: any) => R.createElement('div', null, p.children);
  return { View, ScrollView: View };
});
vi.mock('@swift/ui', () => ({ color: fx.token, radius: fx.token, space: fx.token }));
vi.mock('../../../kit', async () => {
  const R = await import('react');
  const h = R.createElement;
  const Box = (p: any) => h('div', null, p.children);
  return {
    Screen: Box, IconChip: () => null, LoadingBlock: () => h('span', null, 'loading'), ErrorState: () => h('span', null, 'failed'),
    T: (p: any) => h('span', null, p.children),
    Stars: (p: any) => h('button', { type: 'button', onClick: () => p.onRate?.(5) }, 'stars'),
    PillButton: (p: any) => h('button', { type: 'button', onClick: p.onPress, disabled: !!p.disabled }, p.label),
  };
});
vi.mock('../../../hooks/customer', () => ({ useRateOrder: () => ({ mutate: fx.rate, isPending: false }) }));
vi.mock('../../../lib/money', () => ({ money: (n: number) => `GY$${Number(n).toLocaleString('en-US')}` }));
vi.mock('../../../services/api', () => ({ rideApi: { get: () => Promise.resolve({ data: { data: fx.ride } }) } }));

import { RideDetailScreen } from './RideDetailScreen';

const finished = (over: Record<string, unknown> = {}) => ({
  id: 'r1', orderNumber: 'SW-1', status: 'DELIVERED', pickupAddress: 'Stabroek', deliveryAddress: 'Kitty', taxiFareTotal: 800, totalAmount: 1100, hasBeenRated: false,
  driver: { vehicleColor: 'White', vehicleMake: 'Toyota', vehicleModel: 'Axio', licensePlate: 'PAB 1234', user: { firstName: 'Dan' } },
  fareBreakdown: { routeFare: 800, waitingMinutes: 12, waitingCharge: 300, total: 1100, currencyCode: 'GYD' }, ...over,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const navigate = vi.fn();
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 1)); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
async function show(ride: Record<string, unknown>) {
  fx.ride = ride;
  await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(RideDetailScreen, { navigation: { navigate }, route: { params: { rideId: 'r1' } } }))));
  await settle();
}

beforeEach(() => {
  navigate.mockClear(); fx.rate.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); client.clear(); });

describe('[G06] the finished ride', () => {
  it('says who drove, the car, the route and what was paid, with waiting on its own line', async () => {
    await show(finished());
    for (const word of ['Trip complete', 'Dan', 'White Toyota Axio · PAB 1234', 'Stabroek', 'Kitty', 'GY$800', 'Waiting (12 min)', 'GY$300', 'GY$1,100']) expect(host.textContent).toContain(word);
  });

  it('rates once: the stars send, and the rating door goes', async () => {
    await show(finished());
    expect(button('Send rating')!.disabled).toBe(true);
    await act(async () => { button('stars')!.click(); });
    await act(async () => { button('Send rating')!.click(); });
    expect(fx.rate).toHaveBeenCalledWith({ driverScore: 5 }, expect.anything());
    expect(button('Send rating')).toBeUndefined();
  });

  it('a ride already rated, or not finished, asks nothing', async () => {
    await show(finished({ hasBeenRated: true }));
    expect(button('Send rating')).toBeUndefined();
    client.clear();
    await show(finished({ status: 'CANCELLED', cancellationReason: 'Swift support cancelled this ride.' }));
    await settle();
    expect(host.textContent).toContain('Ride cancelled');
  });

  it('a cancelled ride shows no total: nothing was paid', async () => {
    await show(finished({ status: 'CANCELLED', fareBreakdown: undefined }));
    expect(host.textContent).not.toContain('GY$1,100');
  });

  it('help goes with the ride attached', async () => {
    await show(finished());
    await act(async () => { button('Get help with this ride')!.click(); });
    expect(navigate).toHaveBeenCalledWith('GetHelp', { orderId: 'r1', subject: 'Ride SW-1' });
  });
});
