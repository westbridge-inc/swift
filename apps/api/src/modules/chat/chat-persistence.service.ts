import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { assertRoomAccess, type RoomAccess } from './chat-authority';

/** Assignment/status writers update the parent row; room closure updates the
 * room row. Hold both shared locks through the authority check and message
 * write. A change committed first is observed; a later change waits for this
 * legitimate send to commit. Lock parent before room to match lifecycle writes. */
export async function withLockedChatAccess<T>(
  db: Pick<PrismaClient, '$transaction'>,
  roomId: string,
  userId: string,
  tenantId: string | null | undefined,
  write: (tx: Prisma.TransactionClient, access: RoomAccess) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    const room = await tx.chatRoom.findUnique({ where: { id: roomId }, select: { orderId: true, serviceJobId: true } });
    if (!room) throw new NotFoundError('Chat room', roomId);
    if (room.orderId) {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${room.orderId} FOR SHARE`;
    } else if (room.serviceJobId) {
      await tx.$queryRaw`SELECT id FROM service_jobs WHERE id = ${room.serviceJobId} FOR SHARE`;
    } else {
      throw new NotFoundError('Chat room', roomId);
    }
    await tx.$queryRaw`SELECT id FROM chat_rooms WHERE id = ${roomId} FOR SHARE`;
    const current = await tx.chatRoom.findUnique({ where: { id: roomId }, select: { orderId: true, serviceJobId: true } });
    if (!current || current.orderId !== room.orderId || current.serviceJobId !== room.serviceJobId) {
      throw new AppError(409, 'ROOM_CHANGED', 'This conversation changed. Open it again.');
    }
    const access = await assertRoomAccess(tx, roomId, userId, { write: true, tenantId });
    return write(tx, access);
  });
}
