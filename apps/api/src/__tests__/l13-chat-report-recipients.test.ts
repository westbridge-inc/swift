import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationService } from '../modules/notification/notification.service';
import { moderationRoutes } from '../modules/moderation/moderation.routes';
import { runWithoutTenant } from '../plugins/prisma';
import { chatFixture } from './helpers/l05-chat-fixture';

// ---------------------------------------------------------------------------
// Owner ruling, 14 Oct 2026: a person who RECEIVED a chat message while part
// of the conversation may still report it after being taken off the order
// (safety beats symmetry; a report reveals nothing new to them). The message
// records who it was sent to when it is written, under the room lock; a
// former participant may report exactly those messages, nothing else.
// ---------------------------------------------------------------------------

let f: Awaited<ReturnType<typeof chatFixture>>;
beforeAll(async () => {
  f = await chatFixture({ register: async (app) => { await app.register(moderationRoutes, { prefix: '/api/v1' }); } });
});
beforeEach(async () => {
  await f.reset();
  vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue(undefined as never);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  if (f) {
    await runWithoutTenant(() => f.app.prisma.contentReport.deleteMany({
      where: { reporterId: { in: [f.customer.userId, f.oldMover.userId, f.newMover.userId] } },
    }), 'test-cleanup:l13-chat-report');
    await f.close();
  }
});

const send = (token: string, message: string) =>
  f.inject('POST', `/rooms/${f.room.id}/messages`, token, { message });
const report = (token: string, targetId: string) => f.app.inject({
  method: 'POST', url: '/api/v1/reports', headers: { authorization: `Bearer ${token}` },
  payload: { targetType: 'CHAT_MESSAGE', targetId, reason: 'HARASSMENT' },
});
const reportsBy = (reporterId: string, targetId: string) =>
  runWithoutTenant(() => f.app.prisma.contentReport.count({ where: { reporterId, targetType: 'CHAT_MESSAGE', targetId } }), 'test-read:l13-chat-report');

describe('a person taken off the order can report what they received while on it', () => {
  it('the message records, at write time, who it was sent to (the other participants, not the sender)', async () => {
    const sent = await send(f.customer.token, 'recipients fixture');
    expect(sent.statusCode, sent.body).toBe(200);
    const row = await f.app.prisma.chatMessage.findUniqueOrThrow({ where: { id: sent.json().data.id }, select: { recipientIds: true } });
    expect(row.recipientIds).toEqual([f.oldMover.userId]);
  });

  it('after reassignment, the former driver reports a message they received: accepted, and once only', async () => {
    const sent = await send(f.customer.token, 'abusive fixture to the first driver');
    const messageId = sent.json().data.id as string;
    await f.revoke();
    const first = await report(f.oldMover.token, messageId);
    expect(first.statusCode, first.body).toBe(201);
    const again = await report(f.oldMover.token, messageId);
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyReported).toBe(true);
    expect(await reportsBy(f.oldMover.userId, messageId)).toBe(1);
  });

  it('a message sent after the reassignment was never theirs: refused, nothing recorded', async () => {
    await f.revoke();
    const sent = await send(f.customer.token, 'fixture for the new driver only');
    const messageId = sent.json().data.id as string;
    const res = await report(f.oldMover.token, messageId);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('fixture for the new driver only');
    expect(await reportsBy(f.oldMover.userId, messageId)).toBe(0);
  });

  it('a message with no recorded recipients (written before this change) stays reportable only by current participants', async () => {
    await f.revoke();
    expect((await report(f.oldMover.token, f.message.id)).statusCode).toBe(403);
    expect((await report(f.newMover.token, f.message.id)).statusCode).toBe(201);
  });

  it('a person who was never in the conversation is refused, recipient list or not', async () => {
    const sent = await send(f.customer.token, 'fixture the second driver never got');
    const res = await report(f.newMover.token, sent.json().data.id as string);
    // The new driver is not on the order yet: neither current nor a recipient.
    expect(res.statusCode).toBe(403);
  });
});
