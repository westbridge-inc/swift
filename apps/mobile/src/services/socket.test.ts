import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSessionSnapshot } from '../lib/authSession';

const mocks = vi.hoisted(() => {
  const state: { current: AuthSessionSnapshot | null; options: any } = {
    current: null,
    options: null,
  };
  const socket = {
    connected: false,
    connect: vi.fn(() => {
      socket.connected = true;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  return {
    state,
    socket,
    io: vi.fn((_url: string, options: any) => {
      state.options = options;
      return socket;
    }),
  };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));
vi.mock('./api', () => ({ API_URL: 'https://api.test' }));
vi.mock('../stores/authStore', () => ({
  getAuthSessionSnapshot: () => mocks.state.current,
  useAuthStore: {
    getState: () => ({ accessToken: mocks.state.current?.accessToken ?? null }),
  },
}));

import { connectSocket, disconnectSocket } from './socket';

const aSession: AuthSessionSnapshot = {
  generation: 1,
  userId: 'account-a',
  accessToken: 'access-a',
  refreshToken: 'refresh-a',
};
const bSession: AuthSessionSnapshot = {
  generation: 3,
  userId: 'account-b',
  accessToken: 'access-b',
  refreshToken: 'refresh-b',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.socket.connected = false;
  mocks.state.current = null;
  mocks.state.options = null;
});

describe('socket principal ownership', () => {
  it('never lends A reconnects B credentials or lets A teardown disconnect B', () => {
    mocks.state.current = aSession;
    connectSocket();
    expect(mocks.socket.connected).toBe(true);

    // A is still the runtime owner. Merely logging B in must not let an old A
    // reconnect callback borrow B's access token.
    mocks.state.current = bSession;
    let reconnectToken: unknown = 'not-called';
    mocks.state.options.auth((payload: { token?: unknown }) => {
      reconnectToken = payload.token;
    });
    expect(reconnectToken).toBeNull();

    // B explicitly claims a fresh connection. A's delayed logout import must
    // become a no-op after that handoff.
    connectSocket();
    expect(mocks.socket.connected).toBe(true);
    expect(mocks.socket.disconnect).toHaveBeenCalledTimes(1);

    disconnectSocket(aSession);
    expect(mocks.socket.connected).toBe(true);
    expect(mocks.socket.disconnect).toHaveBeenCalledTimes(1);

    disconnectSocket(bSession);
    expect(mocks.socket.connected).toBe(false);
    expect(mocks.socket.disconnect).toHaveBeenCalledTimes(2);
  });
});
