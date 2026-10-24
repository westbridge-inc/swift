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
// once. The previous `__DEV__ ? localhost : api.swiftgy.com` hardcode had no env
// escape hatch, so a non-prod build could never reach a non-prod socket.
// Read API_URL when connecting: store handoffs now load this module during
// API/auth initialization, before the API export is necessarily initialized.

let socket: Socket | null = null;
let socketOwner: AuthPrincipalBoundary | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_URL, {
      autoConnect: false,
      transports: ['websocket', 'polling'],
      // Try polling when a carrier proxy rejects the first WebSocket transport.
      tryAllTransports: true,
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

/** A same-account store handoff must leave the old store's server room WITHOUT
 *  discarding the shared socket other mounted layers hold: a mover's dispatch
 *  offers, a customer's live tracking. Rooms belong to one connection and the
 *  server has no vendor-room leave, so reconnect THIS instance. socket.io keeps
 *  listeners on the instance across disconnect()/connect(), and every layer's
 *  'connect' handler re-joins what it still needs. Emits buffered for the
 *  retired connection are dropped, never replayed into the new one. */
export function reconnectSocketForStoreHandoff(): void {
  const current = socket;
  if (!current || !socketOwner) return;
  if (!samePrincipalBoundary(socketOwner, getAuthSessionSnapshot())) {
    // Never reconnect another account's socket under this session.
    disconnectSocket();
    return;
  }
  current.sendBuffer = [];
  current.receiveBuffer = [];
  if (!current.active) return;
  current.disconnect();
  current.connect();
}

// Joins the order's socket room (server verifies the order belongs to this
// user) — the entry point for live `rider:location` / `driver:location` events
// on the tracking screens. GPS UPLOAD stays on the REST PUT /location routes,
// which check entity ownership; there is intentionally no socket upload path.
export function subscribeToOrder(orderId: string) {
  const s = getSocket();
  s.emit('order:subscribe', { orderId });
}
