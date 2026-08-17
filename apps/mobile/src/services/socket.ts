import { io, Socket } from 'socket.io-client';
import { getAuthSessionSnapshot } from '../stores/authStore';
import {
  authSessionForPrincipal,
  samePrincipalBoundary,
  type AuthPrincipalBoundary,
} from '../lib/authSession';
import { API_URL } from './api';
import { canTeardownRuntime } from '../lib/runtimeOwnership';

// The realtime socket rides the SAME origin as the REST API — including the
// EXPO_PUBLIC_API_URL override — so a staging/preview EAS build repoints both at
// once. The previous `__DEV__ ? localhost : api.swift.gy` hardcode had no env
// escape hatch, so a non-prod build could never reach a non-prod socket.
const SOCKET_URL = API_URL;

let socket: Socket | null = null;
let socketOwner: AuthPrincipalBoundary | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket'],
      // Callback form: every (re)connection attempt reads the CURRENT access
      // token. A static object froze the login-time token, so any reconnect
      // after a token refresh was rejected forever — an online mover silently
      // stopped receiving dispatch offers after a network blip.
      auth: (cb) => {
        const current = getAuthSessionSnapshot();
        cb({
          token: socketOwner
            ? authSessionForPrincipal(current, socketOwner)?.accessToken ?? null
            : null,
        });
      },
    });
  }
  return socket;
}

export function connectSocket() {
  const current = getAuthSessionSnapshot();
  if (!current) {
    disconnectSocket();
    return;
  }
  if (socketOwner && !samePrincipalBoundary(socketOwner, current)) {
    // A socket carries user-scoped rooms and listeners. Cross-principal reuse
    // is never safe, even though the auth callback itself is generation-bound.
    socket?.disconnect();
    socket = null;
  }
  socketOwner = { generation: current.generation, userId: current.userId };
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
}

export function disconnectSocket(expectedOwner?: AuthPrincipalBoundary): boolean {
  if (!canTeardownRuntime(socketOwner, expectedOwner)) return false;
  const ownedSocket = socket;
  socket = null;
  socketOwner = null;
  // `disconnect()` also cancels an in-progress connect/reconnect. Checking
  // only `.connected` leaves an old account's Manager alive between attempts.
  ownedSocket?.disconnect();
  return true;
}

// Joins the order's socket room (server verifies the order belongs to this
// user) — the entry point for live `rider:location` / `driver:location` events
// on the tracking screens. GPS UPLOAD stays on the REST PUT /location routes,
// which check entity ownership; there is intentionally no socket upload path.
export function subscribeToOrder(orderId: string) {
  const s = getSocket();
  s.emit('order:subscribe', { orderId });
}
