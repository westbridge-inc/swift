import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../modules/notification/notification.service';
import { chatFixture } from './helpers/l05-chat-fixture';
import type { Prisma } from '@prisma/client';

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

  it('a send that owns the parent read lock commits before a competing reassignment', async () => {
    let reached!: () => void; let resume!: () => void;
    const atWrite = new Promise<void>((resolve) => { reached = resolve; });
    const resumeWrite = new Promise<void>((resolve) => { resume = resolve; });
    const pauseCreate = (db: Pick<Prisma.TransactionClient, 'chatMessage'>) => {
      const create = db.chatMessage.create.bind(db.chatMessage);
      vi.spyOn(db.chatMessage, 'create').mockImplementationOnce((async (args: Prisma.ChatMessageCreateArgs) => {
        reached(); await resumeWrite; return create(args);
      }) as never);
    };
    // Instrument both the old root-client path and the corrected transaction
    // path so the regression reaches the same deterministic write barrier.
    pauseCreate(f.app.prisma);
    const transaction = f.app.prisma.$transaction.bind(f.app.prisma);
    vi.spyOn(f.app.prisma, '$transaction').mockImplementationOnce((async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => transaction(async (tx) => {
      pauseCreate(tx); return fn(tx);
    })) as never);
    const sending = f.inject('POST', `/rooms/${f.room.id}/messages`, f.oldMover.token, { message: 'send-first fixture' }).then((r) => r);
    let reassignment: Promise<unknown> | undefined;
    try {
      await atWrite;
      let started!: () => void; let pid = 0; let committed = false;
      const backendKnown = new Promise<void>((resolve) => { started = resolve; });
      // Use the original transaction entry so this competing writer is not
      // the instrumented chat transaction.
      reassignment = transaction(async (tx) => {
        pid = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        started();
        await tx.order.update({ where: { id: f.order.id }, data: { driverId: f.newMover.driverId } });
      }).then(() => { committed = true; return 'committed'; });
      await backendKnown;
      const lockVerdict = (async () => {
        const deadline = Date.now() + 4000;
        while (!committed && Date.now() < deadline) {
          const rows = await f.app.prisma.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity
            WHERE pid = ${pid} AND datname = current_database()`;
          if (rows[0]?.waiting) return 'locked';
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return committed ? 'committed' : 'unverified';
      })();
      expect(await Promise.race([reassignment, lockVerdict])).toBe('locked');
    } finally {
      resume();
      const res = await sending;
      expect(res.statusCode, res.body).toBe(200);
      await reassignment;
    }
    expect(await f.app.prisma.chatMessage.count({ where: { chatRoomId: f.room.id, senderId: f.oldMover.userId, message: 'send-first fixture' } })).toBe(1);
  });
});
