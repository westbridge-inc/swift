import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore';

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

export function subscribeToOrder(orderId: string) {
  const s = getSocket();
  s.emit('order:subscribe', { orderId });
}

export function sendLocationUpdate(latitude: number, longitude: number, heading?: number) {
  const s = getSocket();
  s.emit('location:update', { latitude, longitude, heading, timestamp: Date.now() });
}
