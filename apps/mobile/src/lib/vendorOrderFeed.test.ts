import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindVendorOrderFeed } from './vendorOrderFeed';
import { POLL } from './pollPolicy';
const fx = vi.hoisted(() => ({ connected: false }));
vi.mock('../services/socket', () => ({ getSocket: () => fx }));
afterEach(() => { fx.connected = false; });

function fakeSocket() {
  const handlers = new Map<string, Set<(payload?: any) => void>>();
  return {
    emitted: [] as Array<[string, unknown]>,
    emit(event: string, payload: unknown) { this.emitted.push([event, payload]); },
    on(event: string, cb: (payload?: any) => void) { (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(cb); },
    off(event: string, cb: (payload?: any) => void) { handlers.get(event)?.delete(cb); },
    fire(event: string, payload?: unknown) { for (const cb of handlers.get(event) ?? []) cb(payload); },
    count() { return [...handlers.values()].reduce((n, set) => n + set.size, 0); },
  };
}
const noop = () => {};

describe('vendor order feed', () => {
  it('refreshes the order queries on every order event the store room carries, including pick state', () => {
    const socket = fakeSocket();
    const refresh = vi.fn();
    const off = bindVendorOrderFeed(socket, 'store-a', () => true, { onNew: noop, refresh, refreshBookings: noop }, { serverAdmits: true });
    expect(socket.emitted).toEqual([['vendor:subscribe', { vendorId: 'store-a' }]]);
    socket.fire('order:status_changed');
    socket.fire('order:prep_update');
    socket.fire('order:pick_state', { orderId: 'o1', lineId: 'l1', picked: true });
    expect(refresh).toHaveBeenCalledTimes(3);
    off();
    expect(socket.count()).toBe(0);
  });

  it('stretches vendor order polls only while a live store feed is bound, never on a bare connected socket', () => {
    fx.connected = true;
    // A held store shows its orders with the socket still connected but no feed.
    expect(POLL.vendorOrders()).toBe(12000);
    expect(POLL.vendorOrder()).toBe(15000);
    const off = bindVendorOrderFeed(fakeSocket(), 'store-a', () => true, { onNew: noop, refresh: noop, refreshBookings: noop }, { serverAdmits: true });
    expect(POLL.vendorOrders()).toBe(30000);
    expect(POLL.vendorOrder()).toBe(30000);
    off();
    expect(POLL.vendorOrders()).toBe(12000);
  });

  // The server's vendor:subscribe admits only the store owner; a staff or
  // manager device binds listeners that never receive an event.
  it('does not stretch for a device the store room will not admit (staff, manager)', () => {
    fx.connected = true;
    const off = bindVendorOrderFeed(fakeSocket(), 'store-a', () => true, { onNew: noop, refresh: noop, refreshBookings: noop }, { serverAdmits: false });
    expect(POLL.vendorOrders()).toBe(12000);
    expect(POLL.vendorOrder()).toBe(15000);
    off();
  });
});
