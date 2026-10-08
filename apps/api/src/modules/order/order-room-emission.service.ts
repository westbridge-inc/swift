import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { resolveRoomAuthority } from '../chat/chat-authority';
import { cancelledWhileHeld } from './hold-visibility';

type Audience = { tenantId: string; users: Set<string>; senderAllowed?: boolean };

/** Membership is a subscription cache, never authorization. Snapshot sockets
 * before reading the current audience and address the proven socket IDs only:
 * a delayed join cannot receive an event by joining between the read and emit.
 * Database or adapter failure suppresses the event, with no room fallback. */
async function publishToAudience(
  io: Server, room: string, resolve: () => Promise<Audience | null>,
  event: string | null, payload: unknown,
  opts: { senderId?: string; excludeSocketId?: string } = {},
): Promise<boolean> {
  try {
    const sockets = await io.in(room).fetchSockets();
    const audience = await resolve();
    const recipients: string[] = [];
    for (const socket of sockets) {
      const expires = socket.data.authorizationExpiresAtMs as unknown;
      const allowed = audience != null
        && socket.data.tenantId === audience.tenantId
        && typeof socket.data.userId === 'string'
        && audience.users.has(socket.data.userId)
        && typeof expires === 'number' && Number.isFinite(expires) && expires > Date.now();
      if (!allowed) await socket.leave(room);
      else if (socket.id !== opts.excludeSocketId) recipients.push(socket.id);
    }
    if (!audience || (opts.senderId && (!audience.users.has(opts.senderId) || audience.senderAllowed === false))) return false;
    if (event && recipients.length) io.to(recipients).emit(event, payload);
    return true;
  } catch {
    return false;
  }
}

/** All order publishers, including background jobs, use the same live audience
 * as the subscription door: customer, current movers, and the visible store's
 * owner. No admin/staff audience is introduced here. */
export async function emitToOrderRoom(
  db: Pick<PrismaClient, 'order' | 'chatRoom'>, io: Server,
  orderId: string, event: string, payload: unknown,
): Promise<boolean> {
  return publishToAudience(io, `order:${orderId}`, async () => {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        tenantId: true, customerId: true,
        rider: { select: { userId: true } }, driver: { select: { userId: true } },
        vendor: { select: { owner: { select: { userId: true } } } },
        holdExpiresAt: true, cancelledAt: true, paymentMethod: true,
      },
    });
    if (!order) return null;
    const conversationUsers = new Set([order.customerId]);
    if (order.rider) conversationUsers.add(order.rider.userId);
    if (order.driver) conversationUsers.add(order.driver.userId);
    // Lifecycle publication also evicts cached chat subscriptions immediately
    // after reassignment, without waiting for the next message or typing event.
    if (event === 'order:status_changed') {
      const rooms = await db.chatRoom.findMany({ where: { orderId }, select: { id: true } });
      for (const room of rooms) {
        await publishToAudience(io, `chat:${room.id}`, async () => ({ tenantId: order.tenantId, users: conversationUsers }), null, undefined);
      }
    }
    const users = new Set(conversationUsers);
    if (order.vendor && (!order.holdExpiresAt || order.holdExpiresAt <= new Date()) && !cancelledWhileHeld(order)) {
      users.add(order.vendor.owner.userId);
    }
    return { tenantId: order.tenantId, users };
  }, event, payload);
}

/** Chat messages and typing share the order/job authority used by HTTP reads. */
export async function emitToChatRoom(
  db: PrismaClient, io: Server, roomId: string, event: string, payload: unknown,
  opts: { senderId?: string; excludeSocketId?: string } = {},
): Promise<boolean> {
  return publishToAudience(io, `chat:${roomId}`, async () => {
    const authority = await resolveRoomAuthority(db, roomId);
    if (!authority) return null;
    return { tenantId: authority.tenantId, users: new Set(authority.participants.keys()), senderAllowed: authority.writable };
  }, event, payload, opts);
}
