import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { bindMoverJobFeed, MOVER_JOB_EVENTS } from './moverJobFeed';

// [PERF partner #1] A driver or rider used to learn that the live job changed
// (the passenger cancelled, the store marked the order ready) only on the next
// poll: 12 s, 30 s on a slow network. The server already pushes each change to
// the order's room and admits the order's own driver/rider to it.

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

describe('mover live job feed', () => {
  it('joins the room of every live job, and again after every reconnect (rooms belong to one connection)', () => {
    const socket = fakeSocket();
    bindMoverJobFeed(socket, ['order-a', 'order-b'], vi.fn());
    expect(socket.emitted).toEqual([
      ['order:subscribe', { orderId: 'order-a' }],
      ['order:subscribe', { orderId: 'order-b' }],
    ]);
    socket.fire('connect');
    expect(socket.emitted.slice(2)).toEqual([
      ['order:subscribe', { orderId: 'order-a' }],
      ['order:subscribe', { orderId: 'order-b' }],
    ]);
  });

  it('re-reads the job the moment its order changes: a status change or a store prep signal', () => {
    const socket = fakeSocket();
    const refresh = vi.fn();
    bindMoverJobFeed(socket, ['order-a', 'order-b'], refresh);
    socket.fire('order:status_changed', { orderId: 'order-a', status: 'CANCELLED' });
    expect(refresh).toHaveBeenCalledTimes(1);
    socket.fire('order:prep_update', { orderId: 'order-b' });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect([...MOVER_JOB_EVENTS]).toEqual(['order:status_changed', 'order:prep_update']);
  });

  it('ignores another order’s event and any payload without an order id', () => {
    const socket = fakeSocket();
    const refresh = vi.fn();
    bindMoverJobFeed(socket, ['order-a'], refresh);
    socket.fire('order:status_changed', { orderId: 'order-z', status: 'DELIVERED' });
    socket.fire('order:status_changed');
    socket.fire('order:status_changed', { orderId: 42 });
    socket.fire('order:prep_update', {});
    expect(refresh).not.toHaveBeenCalled();
  });

  it('with no live job it joins nothing and listens to nothing', () => {
    const socket = fakeSocket();
    const off = bindMoverJobFeed(socket, ['', ''], vi.fn());
    expect(socket.emitted).toEqual([]);
    expect(socket.count()).toBe(0);
    off();
  });

  it('unbinding removes every listener, once, and never leaves the room another screen may hold', () => {
    const socket = fakeSocket();
    const refresh = vi.fn();
    const off = bindMoverJobFeed(socket, ['order-a'], refresh);
    expect(socket.count()).toBe(1 + MOVER_JOB_EVENTS.length);
    off();
    off();
    expect(socket.count()).toBe(0);
    socket.fire('order:status_changed', { orderId: 'order-a' });
    socket.fire('connect');
    expect(refresh).not.toHaveBeenCalled();
    expect(socket.emitted.filter(([event]) => event !== 'order:subscribe')).toEqual([]);
    expect(socket.emitted).toHaveLength(1);
  });

  it('the refresh the hook binds re-reads only the active job, not the rest of the mover’s reads, and never cancels a read in flight', async () => {
    // The exact call hooks/moverJobFeed.ts binds (its source is pinned in
    // hooks/moverJobFeed.test.ts), driven against a real query client.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const kind = 'DRIVER';
    let release: (v: unknown) => void = () => {};
    const active = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const earnings = vi.fn(async () => ({ total: 0 }));
    const watch = [
      new QueryObserver(qc, { queryKey: ['mover', 'active', kind], queryFn: active }),
      new QueryObserver(qc, { queryKey: ['mover', 'earnings', kind], queryFn: earnings }),
    ];
    const unsubscribe = watch.map((o) => o.subscribe(() => {}));
    await vi.waitFor(() => expect(earnings).toHaveBeenCalledTimes(1));
    expect(active).toHaveBeenCalledTimes(1); // first read still in flight
    const socket = fakeSocket();
    bindMoverJobFeed(socket, ['order-a'], () =>
      qc.invalidateQueries({ queryKey: ['mover', 'active', kind] }, { cancelRefetch: false }));
    socket.fire('order:status_changed', { orderId: 'order-a', status: 'CANCELLED' });
    await Promise.resolve();
    // In flight: the event does not cancel it and start another.
    expect(active).toHaveBeenCalledTimes(1);
    release({ id: 'order-a', status: 'ASSIGNED' });
    await vi.waitFor(() => expect(qc.getQueryData(['mover', 'active', kind])).toEqual({ id: 'order-a', status: 'ASSIGNED' }));
    socket.fire('order:status_changed', { orderId: 'order-a', status: 'CANCELLED' });
    await vi.waitFor(() => expect(active).toHaveBeenCalledTimes(2));
    release(null);
    await vi.waitFor(() => expect(qc.getQueryData(['mover', 'active', kind])).toBeNull());
    expect(earnings).toHaveBeenCalledTimes(1);
    unsubscribe.forEach((u) => u());
    qc.clear();
  });
});
