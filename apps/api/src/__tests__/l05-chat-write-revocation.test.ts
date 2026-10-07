import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../modules/notification/notification.service';
import { chatFixture } from './helpers/l05-chat-fixture';

let f: Awaited<ReturnType<typeof chatFixture>>;
beforeAll(async () => { f = await chatFixture(); });
beforeEach(async () => {
  await f.reset();
  vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue(undefined as never);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await f?.close(); });

describe('message persistence rechecks current participation', () => {
  it('a reassignment that commits during the contact check refuses the former mover without writing or sending', async () => {
    const read = f.app.prisma.userBlock.findFirst.bind(f.app.prisma.userBlock);
    const spy = vi.spyOn(f.app.prisma.userBlock, 'findFirst').mockImplementationOnce(async (args) => {
      const result = await read(args);
      await f.revoke();
      return result;
    });
    const before = await f.app.prisma.chatMessage.count({ where: { chatRoomId: f.room.id } });
    const emit = vi.spyOn(f.app.io, 'to');
    const res = await f.inject('POST', `/rooms/${f.room.id}/messages`, f.oldMover.token, { message: 'stale writer fixture' });
    expect(spy).toHaveBeenCalled();
    expect(res.statusCode, res.body).toBe(403);
    expect(await f.app.prisma.chatMessage.count({ where: { chatRoomId: f.room.id } })).toBe(before);
    expect(emit).not.toHaveBeenCalled();
    expect(NotificationService.prototype.send).not.toHaveBeenCalled();
  });

  it('closing the room during the contact check refuses persistence', async () => {
    const read = f.app.prisma.userBlock.findFirst.bind(f.app.prisma.userBlock);
    vi.spyOn(f.app.prisma.userBlock, 'findFirst').mockImplementationOnce(async (args) => {
      const result = await read(args);
      await f.app.prisma.chatRoom.update({ where: { id: f.room.id }, data: { isActive: false } });
      return result;
    });
    const res = await f.inject('POST', `/rooms/${f.room.id}/messages`, f.oldMover.token, { message: 'closed writer fixture' });
    expect(res.statusCode, res.body).toBe(409);
    expect(await f.app.prisma.chatMessage.count({ where: { chatRoomId: f.room.id, message: 'closed writer fixture' } })).toBe(0);
  });

  it('the newly assigned mover can send and the former mover cannot', async () => {
    await f.revoke();
    const denied = await f.inject('POST', `/rooms/${f.room.id}/messages`, f.oldMover.token, { message: 'denied fixture' });
    expect(denied.statusCode).toBe(403);
    const allowed = await f.inject('POST', `/rooms/${f.room.id}/messages`, f.newMover.token, { message: 'current writer fixture' });
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json().data.message).toBe('current writer fixture');
    expect(await f.app.prisma.chatMessage.count({ where: { chatRoomId: f.room.id, senderId: f.newMover.userId, message: 'current writer fixture' } })).toBe(1);
  });
});
