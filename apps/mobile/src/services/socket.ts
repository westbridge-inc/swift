import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore';

// eslint-disable-next-line no-undef
const SOCKET_URL = __DEV__ ? 'http://localhost:3000' : 'https://api.swift.gy';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      autoConnect: false,
      transports: ['websocket'],
      auth: { token: useAuthStore.getState().accessToken },
    });
  }
  return socket;
}

export function connectSocket() {
  const s = getSocket();
  if (!s.connected) {
    s.auth = { token: useAuthStore.getState().accessToken };
    s.connect();
  }
}

export function disconnectSocket() {
  if (socket?.connected) {
    socket.disconnect();
  }
}

// Joins the order's socket room (server verifies the order belongs to this
// user) — the entry point for live `rider:location` / `driver:location` events
// on the tracking screens. GPS UPLOAD stays on the REST PUT /location routes,
// which check entity ownership; there is intentionally no socket upload path.
export function subscribeToOrder(orderId: string) {
  const s = getSocket();
  s.emit('order:subscribe', { orderId });
}
