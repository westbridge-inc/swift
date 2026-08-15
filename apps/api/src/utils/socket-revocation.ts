import type { Server } from 'socket.io';

/**
 * Authorization-only rooms are joined before the post-handshake authority
 * recheck. They never carry product events, so a socket can be made visible to
 * a concurrent revocation without briefly receiving user/order data.
 */
export const socketAuthUserRoom = (userId: string) => `auth:user:${userId}`;
export const socketAuthSessionRoom = (sessionId: string) => `auth:session:${sessionId}`;

function disconnectRoom(io: Server, room: string): void {
  // The Redis adapter's cluster broadcast is intentionally best-effort and its
  // public disconnectSockets API is synchronous. Evict the local members first
  // so a Redis outage cannot leave sockets alive on the node that committed the
  // revocation, then publish the same command to peer API nodes.
  const localSocketIds = [...(io.sockets.adapter.rooms.get(room) ?? [])];
  for (const socketId of localSocketIds) {
    io.sockets.sockets.get(socketId)?.disconnect(true);
  }
  io.in(room).disconnectSockets(true);
}

/**
 * User-wide revocation also targets the pre-auth user room. Nodes from before
 * the auth-room change joined that room, so logout-all remains rolling-safe.
 */
export function disconnectUserSockets(io: Server | undefined, userId: string): void {
  if (!io) return;
  disconnectRoom(io, socketAuthUserRoom(userId));
  disconnectRoom(io, `user:${userId}`);
}

/**
 * Exact-session revocation deliberately preserves a user's other devices. It
 * targets both current session rooms, but is NOT compatible with API nodes that
 * predate session-room membership. Ship this authority change with SWIFT's
 * mandatory non-rolling cutover; widening it to user-wide logout would break
 * the product's single-device logout contract.
 */
export function disconnectSessionSockets(io: Server | undefined, sessionId: string): void {
  if (!io) return;
  disconnectRoom(io, socketAuthSessionRoom(sessionId));
  disconnectRoom(io, `session:${sessionId}`);
}
