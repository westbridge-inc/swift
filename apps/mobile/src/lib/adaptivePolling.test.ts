import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { adaptivePollInterval } from './adaptivePolling';
import { watchSlowQueries, isSlowConnection } from './slowQueries';
const fx = vi.hoisted(() => ({ connected: false }));
vi.mock('../services/socket', () => ({ getSocket: () => fx }));
afterEach(() => { fx.connected = false; vi.useRealTimers(); });
it('reduces connected polling without speeding up slower polls', () => {
  expect(adaptivePollInterval(4000, 15000)).toBe(4000);
  fx.connected = true;
  expect(adaptivePollInterval(4000, 15000)).toBe(15000);
  expect(adaptivePollInterval(12000, 30000)).toBe(30000);
  expect(adaptivePollInterval(60000, 30000)).toBe(60000);
});
it('shares the banner slow signal and clears it on session cache removal', async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const publish = vi.fn();
  const stop = watchSlowQueries(client, publish);
  const observer = new QueryObserver(client, { queryKey: ['fixture'], queryFn: () => new Promise(() => {}) });
  const off = observer.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(5000);
  expect(publish).toHaveBeenLastCalledWith(true);
  expect(isSlowConnection()).toBe(true);
  expect(adaptivePollInterval(4000, 15000)).toBe(15000);
  client.clear();
  expect(isSlowConnection()).toBe(false);
  expect(adaptivePollInterval(12000, 30000)).toBe(12000);
  off(); stop();
});
it('wires dynamic intervals into chat, mover and vendor queries', () => {
  for (const name of ['chat', 'mover', 'vendorops']) {
    const source = readFileSync(new URL(`../hooks/${name}.ts`, import.meta.url), 'utf8');
    expect(source).toContain('adaptivePollInterval(');
    expect(source).not.toMatch(/refetchInterval:\s*(?:4000|10000|12000|15000|20000|20_000),/);
  }
});
