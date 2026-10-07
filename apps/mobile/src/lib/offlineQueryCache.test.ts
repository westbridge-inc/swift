import { createHash } from 'node:crypto';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { bindOfflineQueryCache, projectOfflineData } from './offlineQueryCache';
const digest = async (text: string) => createHash('sha256').update(text).digest('hex');
const homeKey = ['customer', 'home', 6.1, -58.1, 'scope-fixture'];
const fixtureOrder = { id: 'order-fixture', orderNumber: 'W123', status: 'ACCEPTED', orderType: 'FOOD', vertical: 'FOOD', placedAt: '2026-10-05T10:00:00Z', ridePin: 'private-pin', paymentAction: 'private-payment', customer: { phone: 'private-contact' }, deliveryAddress: 'private-address', vendor: { id: 'store-fixture', name: 'Fixture store', bankAccount: 'private-bank' } };
const home = { activeOrder: fixtureOrder, popularItems: [], featured: [], nearby: [], orderAgain: [], categories: [], openVendors: [], closedVendors: [] };
function setup() {
  const disk = new Map<string, string>();
  const storage = { getItem: (key: string) => disk.get(key) ?? null, setItem: (key: string, value: string) => { disk.set(key, value); }, removeItem: (key: string) => { disk.delete(key); } };
  let state = { adEventScopeId: 'scope-fixture', sessionGeneration: 1, user: { id: 'account-fixture' } };
  const listeners = new Set<(s: typeof state) => void>();
  const source = { getState: () => state, subscribe: (cb: (s: typeof state) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } };
  const rotate = () => { state = { ...state, sessionGeneration: 2 }; for (const cb of listeners) cb(state); };
  return { disk, storage, source, rotate };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(1000); }
afterEach(() => vi.useRealTimers());
it('restores sanitized Home and order summaries on a cold offline start in the same session', async () => {
  vi.useFakeTimers(); const env = setup(); const first = new QueryClient();
  const stop = await bindOfflineQueryCache(first, env.source, env.storage, digest);
  first.setQueryData(homeKey, home);
  first.setQueryData(['customer', 'order', 'order-fixture'], fixtureOrder);
  await flush(); stop(); first.clear();
  const serialized = [...env.disk.values()].join('');
  expect(serialized).toContain('Fixture store');
  expect(serialized).not.toContain('private-');
  expect(serialized).not.toContain('-58.1');
  const second = new QueryClient(); const end = await bindOfflineQueryCache(second, env.source, env.storage, digest);
  second.getQueryCache().build(second, { queryKey: homeKey });
  second.getQueryCache().build(second, { queryKey: ['customer', 'order', 'order-fixture'] });
  await flush();
  expect(second.getQueryData<any>(homeKey)?.activeOrder).toMatchObject({ id: 'order-fixture', _offlineSnapshot: true });
  expect(second.getQueryData<any>(['customer', 'order', 'order-fixture'])).toMatchObject({ id: 'order-fixture', _offlineSnapshot: true });
  end(); second.clear();
});
it('wipes disk immediately on session rotation and refuses an old account snapshot', async () => {
  vi.useFakeTimers(); const env = setup(); const client = new QueryClient();
  const stop = await bindOfflineQueryCache(client, env.source, env.storage, digest);
  client.setQueryData(homeKey, home); await flush(); expect(env.disk.size).toBe(1);
  env.rotate(); expect(env.disk.size).toBe(0);
  await flush(); expect(env.disk.size).toBe(0);
  stop(); client.clear();
});
it('never resurrects expired data or overwrites a newer network response', async () => {
  vi.useFakeTimers(); const env = setup(); const first = new QueryClient();
  const stop = await bindOfflineQueryCache(first, env.source, env.storage, digest);
  first.setQueryData(homeKey, home); await flush(); stop(); first.clear();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
  const next = new QueryClient(); const end = await bindOfflineQueryCache(next, env.source, env.storage, digest);
  next.getQueryCache().build(next, { queryKey: homeKey }); await flush();
  expect(next.getQueryData(homeKey)).toBeUndefined();
  expect(env.disk.size).toBe(0);
  next.setQueryData(homeKey, { ...home, activeOrder: null }); await flush();
  expect(next.getQueryData<any>(homeKey).activeOrder).toBeNull();
  end(); next.clear();
});
it('allowlists cache families and fields, including nested vendor and item fields', () => {
  for (const key of [['chat'], ['payments'], ['verification'], ['customer', 'profile'], ['customer', 'addresses']]) expect(projectOfflineData(key, { secret: 'private-data' })).toBeUndefined();
  const publicRows = projectOfflineData(['customer', 'vendors', {}], [{ id: 'store-fixture', name: 'Fixture store', logoUrl: 'https://example.invalid/public.webp', phone: 'private-phone', bank: 'private-bank', owner: { name: 'private-owner' } }]);
  expect(publicRows).toEqual([{ id: 'store-fixture', name: 'Fixture store', logoUrl: 'https://example.invalid/public.webp' }]);
  expect(projectOfflineData(['customer','order','order-fixture'], fixtureOrder)).not.toHaveProperty('ridePin');
  expect(JSON.stringify(projectOfflineData(['customer','orders','live'], { items: [fixtureOrder], total: 1 }))).not.toContain('private-');
  expect(projectOfflineData(['customer','vendors',{}], [{id:'store-fixture',name:'Fixture',logoUrl:'https://example.invalid/image?signature=private-value'}])).toEqual([{id:'store-fixture',name:'Fixture'}]);
});
it('does not restore another account even when opaque scope metadata is accidentally reused', async () => {
  vi.useFakeTimers(); const env = setup(); const first = new QueryClient();
  const stop = await bindOfflineQueryCache(first, env.source, env.storage, digest);
  first.setQueryData(homeKey, home); await flush(); stop(); first.clear();
  const next = new QueryClient();
  const other = { ...env.source, getState: () => ({ ...env.source.getState(), user: { id: 'different-fixture' } }) };
  const end = await bindOfflineQueryCache(next, other, env.storage, digest);
  next.getQueryCache().build(next, { queryKey: homeKey }); await flush();
  expect(next.getQueryData(homeKey)).toBeUndefined(); expect(env.disk.size).toBe(0);
  end(); next.clear();
});
it('does not overwrite a successful network response that wins the restore race', async () => {
  vi.useFakeTimers(); const env = setup(); const first = new QueryClient();
  const stop = await bindOfflineQueryCache(first, env.source, env.storage, digest);
  first.setQueryData(homeKey, home); await flush(); stop(); first.clear();
  const next = new QueryClient(); const end = await bindOfflineQueryCache(next, env.source, env.storage, digest);
  next.getQueryCache().build(next, { queryKey: homeKey });
  next.setQueryData(homeKey, { ...home, activeOrder: null });
  await flush(); expect(next.getQueryData<any>(homeKey).activeOrder).toBeNull();
  end(); next.clear();
});
