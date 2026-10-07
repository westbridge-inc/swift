import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatFixture } from './helpers/l05-chat-fixture';

let f: Awaited<ReturnType<typeof chatFixture>>;
beforeAll(async () => { f = await chatFixture(); });
beforeEach(async () => { await f.reset(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await f?.close(); });

describe('history is returned only to the current participant set', () => {
  it('opening a room refuses the old mover when reassignment commits during its history read', async () => {
    const read = f.app.prisma.chatRoom.findFirst.bind(f.app.prisma.chatRoom);
    const spy = vi.spyOn(f.app.prisma.chatRoom, 'findFirst').mockImplementationOnce(async (args) => {
      const result = await read(args); await f.revoke(); return result;
    });
    const res = await f.inject('POST', '/rooms', f.oldMover.token, { orderId: f.order.id });
    expect(spy).toHaveBeenCalled(); expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain('private history fixture');
    expect(res.json()).not.toHaveProperty('data.messages');
  });

  it('a history page loaded before reassignment is refused at the response boundary', async () => {
    const read = f.app.prisma.chatMessage.findMany.bind(f.app.prisma.chatMessage);
    vi.spyOn(f.app.prisma.chatMessage, 'findMany').mockImplementationOnce(async (args) => {
      const result = await read(args); await f.revoke(); return result;
    });
    const res = await f.inject('GET', `/rooms/${f.room.id}/messages`, f.oldMover.token);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).not.toContain('private history fixture');
  });

  it('the current mover and customer keep access; an already removed mover has none', async () => {
    await f.revoke();
    const denied = await f.inject('GET', `/rooms/${f.room.id}/messages`, f.oldMover.token);
    expect(denied.statusCode).toBe(403);
    for (const p of [f.newMover, f.customer]) {
      const allowed = await f.inject('POST', '/rooms', p.token, { orderId: f.order.id });
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.json().data.messages.some((m: { id: string }) => m.id === f.message.id)).toBe(true);
      expect(allowed.json().data.participants.map((p: { userId: string }) => p.userId)).not.toContain(f.oldMover.userId);
    }
  });
});
