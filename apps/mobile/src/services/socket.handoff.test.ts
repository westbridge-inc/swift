import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

// [AX449 #4] The transport fake keeps socket.io-client 4.8's own semantics
// (build/esm/socket.js): listeners live on the Socket instance and survive
// disconnect()/connect(); server rooms belong to one connection; `active` is
// true while connected or reconnecting; emits made while disconnected wait in
// `sendBuffer` and are flushed by the next connect.
type Handler = (payload?: unknown) => void;
const fx = vi.hoisted(() => {
  const state: { current: AuthSessionSnapshot | null } = { current: null };
  const sockets: Array<ReturnType<typeof makeSocket>> = [];
  function makeSocket() {
    const listeners = new Map<string, Set<Handler>>();
    const fire = (event: string, payload?: unknown) => { for (const fn of [...(listeners.get(event) ?? [])]) fn(payload); };
    const socket = {
      connected: false, active: false, connections: 0,
      rooms: new Set<string>(), sendBuffer: [] as Array<[string, unknown]>, receiveBuffer: [] as unknown[],
      apply(event: string, payload: unknown) { if (event === 'vendor:subscribe') socket.rooms.add((payload as { vendorId: string }).vendorId); },
      on: vi.fn((event: string, fn: Handler) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); }),
      off: vi.fn((event: string, fn: Handler) => { listeners.get(event)?.delete(fn); }),
      emit: vi.fn((event: string, payload: unknown) => {
        if (socket.connected) socket.apply(event, payload); else socket.sendBuffer.push([event, payload]);
      }),
      connect: vi.fn(() => {
        if (socket.connected) return;
        socket.active = true; socket.connected = true; socket.connections++;
        for (const [event, payload] of socket.sendBuffer.splice(0)) socket.apply(event, payload);
        fire('connect');
      }),
      disconnect: vi.fn(() => {
        const was = socket.connected;
        socket.active = false; socket.connected = false; socket.rooms = new Set();
        if (was) fire('disconnect');
      }),
      /** A network drop: still active (socket.io keeps reconnecting), rooms gone. */
      drop() { socket.connected = false; socket.rooms = new Set(); },
      /** The server closed it ('io server disconnect'): socket.io will not reconnect. */
      serverClose() { socket.connected = false; socket.active = false; socket.rooms = new Set(); fire('disconnect', 'io server disconnect'); },
      /** The server delivers to this connection only. */
      server(event: string, payload?: unknown) { if (socket.connected) fire(event, payload); },
    };
    return socket;
  }
  return { state, sockets, io: vi.fn(() => { const s = makeSocket(); sockets.push(s); return s; }) };
});
vi.mock('socket.io-client', () => ({ io: fx.io }));
vi.mock('./api', () => ({ API_URL: 'https://api.test' }));
vi.mock('../stores/authStore', () => ({ getAuthSessionSnapshot: () => fx.state.current }));

import { connectSocket, disconnectSocket, getSocket, reconnectSocketForStoreHandoff } from './socket';

const owner: AuthSessionSnapshot = { generation: 2, userId: 'account-a', accessToken: 'access-a', refreshToken: 'refresh-a' };
const other: AuthSessionSnapshot = { generation: 5, userId: 'account-b', accessToken: 'access-b', refreshToken: 'refresh-b' };

beforeEach(() => {
  fx.state.current = null;
  disconnectSocket();
  fx.sockets.length = 0;
  vi.clearAllMocks();
});

describe('R3 a same-account store handoff keeps every mounted listener', () => {
  it('reconnects the SAME socket: other layers keep their listeners and re-join, the old store room is gone', () => {
    fx.state.current = owner;
    connectSocket();
    const s = fx.sockets[0]!;
    // A customer tracking layer and a mover's dispatch layer, as mounted screens register them.
    const location = vi.fn(); const offer = vi.fn(); const rejoin = vi.fn();
    s.on('driver:location', location); s.on('dispatch:offer', offer); s.on('connect', rejoin);
    s.emit('vendor:subscribe', { vendorId: 'store-a' });
    expect([...s.rooms]).toEqual(['store-a']);

    reconnectSocketForStoreHandoff();

    expect(fx.io).toHaveBeenCalledOnce();
    expect(getSocket()).toBe(s);
    expect(s.disconnect).toHaveBeenCalledOnce();
    expect(s.connections).toBe(2);
    expect([...s.rooms], 'the connection holding the old store room is closed').toEqual([]);
    expect(rejoin, 'each layer re-joins what it still needs').toHaveBeenCalledOnce();
    s.server('driver:location', { orderId: 'order-1' });
    s.server('dispatch:offer', { orderId: 'offer-1' });
    expect(location).toHaveBeenCalledWith({ orderId: 'order-1' });
    expect(offer).toHaveBeenCalledWith({ orderId: 'offer-1' });
  });

  it('drops emits buffered for the retired connection instead of replaying them on the new one', () => {
    fx.state.current = owner;
    connectSocket();
    const s = fx.sockets[0]!;
    s.drop();
    s.emit('vendor:subscribe', { vendorId: 'store-a' });
    expect(s.sendBuffer).toHaveLength(1);
    reconnectSocketForStoreHandoff();
    expect(s.connected).toBe(true);
    expect([...s.rooms]).toEqual([]);
    expect(s.sendBuffer).toEqual([]);
    expect(s.receiveBuffer).toEqual([]);
  });

  it('leaves a socket no account ever claimed untouched', () => {
    fx.state.current = owner;
    const s = getSocket();
    reconnectSocketForStoreHandoff();
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.disconnect).not.toHaveBeenCalled();
    expect(getSocket()).toBe(s);
  });

  it('never revives a socket the server closed, and still drops what it buffered', () => {
    fx.state.current = owner;
    connectSocket();
    const s = fx.sockets[0]!;
    s.serverClose();
    s.emit('vendor:subscribe', { vendorId: 'store-a' });
    reconnectSocketForStoreHandoff();
    expect(s.connect, 'only the initial connect ran').toHaveBeenCalledOnce();
    expect(s.disconnect).not.toHaveBeenCalled();
    expect(s.connected).toBe(false);
    expect(s.sendBuffer).toEqual([]);
    expect(getSocket()).toBe(s);
  });

  it('never reconnects another account’s socket under this session: it is discarded', () => {
    fx.state.current = owner;
    connectSocket();
    const s = fx.sockets[0]!;
    fx.state.current = other;
    reconnectSocketForStoreHandoff();
    expect(s.disconnect).toHaveBeenCalledOnce();
    expect(s.connect).toHaveBeenCalledOnce();
    expect(getSocket()).not.toBe(s);
  });

  it('is a no-op without a socket', () => {
    fx.state.current = owner;
    reconnectSocketForStoreHandoff();
    expect(fx.io).not.toHaveBeenCalled();
  });
});
