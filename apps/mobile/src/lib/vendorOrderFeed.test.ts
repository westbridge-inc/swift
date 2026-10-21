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

// ---------------------------------------------------------------------------
// [PERF partner #6] The store overview (today's numbers) changes only when orders
// do. It polled every 30 s on every owner's tablet; now it refreshes on a new
// order or a status change, catches up after the feed drops and comes back, and
// polls every 120 s while the feed is live and connected (30 s otherwise).
// ---------------------------------------------------------------------------
describe('[PERF partner #6] the store overview follows the order feed', () => {
  it('refreshes on a new order and a status change, not on prep or pick signals', () => {
    const socket = fakeSocket();
    const onNew = vi.fn();
    const refreshOverview = vi.fn();
    const off = bindVendorOrderFeed(socket, 'store-a', () => true, { onNew, refresh: noop, refreshBookings: noop, refreshOverview }, { serverAdmits: true });
    socket.fire('order:new', { orderId: 'o1', orderNumber: 'N1' });
    expect(onNew).toHaveBeenCalledWith({ orderId: 'o1', orderNumber: 'N1' });
    expect(refreshOverview).toHaveBeenCalledTimes(1);
    socket.fire('order:status_changed');
    expect(refreshOverview).toHaveBeenCalledTimes(2);
    socket.fire('order:prep_update');
    socket.fire('order:pick_state', { orderId: 'o1', lineId: 'l1', picked: true });
    socket.fire('bookings:changed');
    expect(refreshOverview).toHaveBeenCalledTimes(2);
    off();
    expect(socket.count()).toBe(0);
  });

  it('a drop refreshes at once; the reconnect after it catches up; a connect with no drop does not', () => {
    const socket = fakeSocket();
    const refreshOverview = vi.fn();
    const off = bindVendorOrderFeed(socket, 'store-a', () => true, { onNew: noop, refresh: noop, refreshBookings: noop, refreshOverview }, { serverAdmits: true });
    socket.fire('connect');
    expect(refreshOverview).not.toHaveBeenCalled();
    socket.fire('disconnect');
    expect(refreshOverview).toHaveBeenCalledTimes(1);
    socket.fire('connect');
    expect(refreshOverview).toHaveBeenCalledTimes(2);
    socket.fire('connect');
    expect(refreshOverview).toHaveBeenCalledTimes(2);
    off();
  });

  it('a feed without an overview handler (older callers) still works', () => {
    const socket = fakeSocket();
    const onNew = vi.fn();
    const off = bindVendorOrderFeed(socket, 'store-a', () => true, { onNew, refresh: noop, refreshBookings: noop }, { serverAdmits: true });
    socket.fire('order:new', { orderId: 'o2' });
    socket.fire('disconnect');
    expect(onNew).toHaveBeenCalledTimes(1);
    off();
  });

  it('the overview polls every 120 s only while a live feed is bound AND connected', () => {
    fx.connected = true;
    expect(POLL.vendorAnalytics()).toBe(30000);
    const off = bindVendorOrderFeed(fakeSocket(), 'store-a', () => true, { onNew: noop, refresh: noop, refreshBookings: noop }, { serverAdmits: true });
    expect(POLL.vendorAnalytics()).toBe(120000);
    fx.connected = false;
    expect(POLL.vendorAnalytics()).toBe(30000);
    off();
    // Staff and managers: the server never joins them to the store room.
    fx.connected = true;
    const staff = bindVendorOrderFeed(fakeSocket(), 'store-a', () => true, { onNew: noop, refresh: noop, refreshBookings: noop }, { serverAdmits: false });
    expect(POLL.vendorAnalytics()).toBe(30000);
    staff();
  });
});
