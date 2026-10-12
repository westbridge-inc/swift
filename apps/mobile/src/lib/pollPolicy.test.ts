import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { POLL } from './pollPolicy';
import { watchSlowQueries } from './slowQueries';
const fx = vi.hoisted(() => ({ connected: false }));
vi.mock('../services/socket', () => ({ getSocket: () => fx }));
afterEach(() => { fx.connected = false; vi.useRealTimers(); });

async function withSlowNetwork(run: () => void) {
  vi.useFakeTimers();
  const client = new QueryClient();
  const stop = watchSlowQueries(client, () => {});
  const off = new QueryObserver(client, { queryKey: ['fixture'], queryFn: () => new Promise(() => {}) }).subscribe(() => {});
  await vi.advanceTimersByTimeAsync(5000);
  try { run(); } finally { off(); stop(); client.clear(); }
}

// Server evidence (apps/api): movers get only dispatch:offer, the offer
// withdrawal and notification on their user room; no mover screen joins an
// order room. So a connected socket says nothing about the board, the active
// job or stacked legs, and must not slow them.
describe('mover queries have no socket push', () => {
  it('keep the board 10 s, active job and legs 12 s while the socket is connected', () => {
    fx.connected = true;
    expect(POLL.moverAvailable()).toBe(10000);
    expect(POLL.moverActive()).toBe(12000);
    expect(POLL.moverLegs()).toBe(12000);
    expect(POLL.moverDemand()).toBe(20000);
    expect(POLL.vendorProfile()).toBe(20000);
  });
  it('still back off on a slow network', async () => {
    await withSlowNetwork(() => {
      expect(POLL.moverAvailable()).toBe(30000);
      expect(POLL.moverActive()).toBe(30000);
      expect(POLL.moverLegs()).toBe(30000);
    });
  });
});

// The chat room carries chat:message, so its poll is only a safety net.
// Vendor order polls stretch only with a bound store feed: vendorOrderFeed.test.ts.
describe('pushed queries', () => {
  it('chat stretches while connected and keeps its normal cadence when not', () => {
    expect(POLL.chatMessages()).toBe(4000);
    fx.connected = true;
    expect(POLL.chatMessages()).toBe(15000);
  });
});
