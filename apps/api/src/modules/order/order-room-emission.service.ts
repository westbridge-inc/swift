import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { resolveRoomAuthority } from '../chat/chat-authority';
import { cancelledWhileHeld } from './hold-visibility';
import { storeTeam } from '../notification/store-team';
import { withVehiclePhotosScanned } from '../../lib/photo-scan-filter';

type Audience = { tenantId: string; users: Set<string>; senderAllowed?: boolean; publisherAllowed?: boolean };

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
    if (!audience || audience.publisherAllowed === false
      || (opts.senderId && (!audience.users.has(opts.senderId) || audience.senderAllowed === false))) return false;
    if (event && recipients.length) io.to(recipients).emit(event, payload);
    return true;
  } catch {
    return false;
  }
}

/** All order publishers, including background jobs, use the same live audience
 * as the subscription door: customer, current movers, and the visible store's
 * owner. No admin/staff audience is introduced here.
 * `fromMover` names the rider/driver whose own sample this is (a GPS ping): it
 * is published only while that mover is still the order's current one, read in
 * the same snapshot as the audience, so a sample authorized just before a
 * reassignment never reaches the customer after it. */
export async function emitToOrderRoom(
  db: Pick<PrismaClient, 'order' | 'chatRoom'>, io: Server,
  orderId: string, event: string, payload: unknown,
  opts: { fromMover?: { riderId: string } | { driverId: string } } = {},
): Promise<boolean> {
  return publishToAudience(io, `order:${orderId}`, async () => {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        tenantId: true, customerId: true,
        rider: { select: { id: true, userId: true } }, driver: { select: { id: true, userId: true } },
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
    const mover = opts.fromMover;
    const publisherAllowed = !mover
      || ('riderId' in mover ? order.rider?.id === mover.riderId : order.driver?.id === mover.driverId);
    return { tenantId: order.tenantId, users, publisherAllowed };
  }, event, await scannedForOrderRoom(db, payload));
}

/** [Row 312 · COORD 23 Oct] An order-room event (the customer's ride and delivery cards) carries no photo
 *  stored under the bypass before its clean rescan (lib/photo-scan-filter.ts). A db without the debt
 *  table cannot tell: every photo in the payload is withheld (fail closed). */
async function scannedForOrderRoom(db: object, payload: unknown): Promise<unknown> {
  // Read lazily: the debt table is touched only when the payload carries a photo field.
  const lazy = { get uploadScanDebt() { return (db as Partial<Pick<PrismaClient, 'uploadScanDebt'>>).uploadScanDebt ?? ({} as PrismaClient['uploadScanDebt']); } };
  return withVehiclePhotosScanned(lazy, payload);
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

/** [Owner ruling #15 · continues #1367] The live room of a store (vendor:<id>):
 * every new order and every change on its board. Its audience is the team of
 * the store as read NOW (store-team.ts: the ACTIVE same-tenant owner, managers
 * and staff), the same rule the subscription door applies, so a member removed
 * or deactivated after joining receives nothing more and is evicted at the next
 * publication. `onlyWhileActive` marks a ringing event (order:new, which
 * raises the takeover on the phone): a store suspended or closed down by Swift
 * publishes it to nobody, while its board still hears every other change
 * (a status change, a cancellation). Closing for the day does not stop it:
 * the orders a store already has keep ringing. Payloads are unchanged. */
export async function emitToStoreRoom(
  db: Pick<PrismaClient, 'vendor'>, io: Server,
  vendorId: string, event: string, payload: unknown,
  opts: { onlyWhileActive?: boolean } = {},
): Promise<boolean> {
  return publishToAudience(io, `vendor:${vendorId}`, async () => {
    const team = await storeTeam(db, vendorId);
    if (!team) return null;
    return { tenantId: team.tenantId, users: new Set(team.userIds), publisherAllowed: !opts.onlyWhileActive || team.ringing };
  }, event, payload);
}
