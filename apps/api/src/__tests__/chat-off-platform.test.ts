import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { NotificationService } from '../modules/notification/notification.service';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { chatRoutes } from '../modules/chat/chat.routes';
import { detectOffPlatformContact } from '../modules/chat/off-platform';

// ---------------------------------------------------------------------------
// Off-platform contact detection (marketplace spec §2): detection, never
// censorship — the message DELIVERS, the sender gets the nudge, the flag
// lands for risk signals.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let userId: string;
let otherId: string;
let roomId: string;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(chatRoutes, { prefix: '/api/v1/chat' });
  await app.ready();

  const mk = async (n: string) =>
    app.prisma.user.create({
      data: {
        phone: `+59262${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: n, lastName: 'Chat',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true,
      },
    });
  const u1 = await mk('Sender');
  const u2 = await mk('Receiver');
  userId = u1.id;
  otherId = u2.id;
  token = app.jwt.sign({ userId: u1.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: u1.id, token, refreshToken: nanoid(48),
      deviceId: 'chat-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });

  const room = await app.prisma.chatRoom.create({
    data: {
      participants: { create: [{ userId: u1.id, role: 'CUSTOMER' }, { userId: u2.id, role: 'RIDER' }] },
    },
  });
  roomId = room.id;
});

afterAll(async () => {
  if (roomId) {
    await app.prisma.chatMessage.deleteMany({ where: { chatRoomId: roomId } });
    await app.prisma.chatRoomParticipant.deleteMany({ where: { chatRoomId: roomId } });
    await app.prisma.chatRoom.deleteMany({ where: { id: roomId } });
  }
  await app.prisma.notification.deleteMany({ where: { userId: { in: [userId, otherId] } } });
  await app.prisma.session.deleteMany({ where: { userId } });
  await app.prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
  await app.close();
});

const send = (message: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/chat/rooms/${roomId}/messages`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { message, messageType: 'text' },
  });

describe('detector truths', () => {
  it('catches numbers and off-platform overtures, spares normal chat', () => {
    expect(detectOffPlatformContact('call me on 592 600 1000')).toBe(true);
    expect(detectOffPlatformContact('my number is 6001000')).toBe(true);
    expect(detectOffPlatformContact('+5926001000')).toBe(true);
    expect(detectOffPlatformContact('whatsapp me instead')).toBe(true);
    expect(detectOffPlatformContact('WhatsApp?')).toBe(true);

    expect(detectOffPlatformContact('the gate code is 4321')).toBe(false);
    expect(detectOffPlatformContact('order #SW-260715-001QDB please')).toBe(false);
    expect(detectOffPlatformContact("I'm outside in the yellow car")).toBe(false);
    expect(detectOffPlatformContact('total was $2,500 right?')).toBe(false);
  });
});

describe('send path', () => {
  it('a flagged message still DELIVERS, carries the nudge, and lands the flag', async () => {
    const res = await send('text me on 592-600-1000 when you reach');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.warning).toContain('Keep it in the app');

    const row = await app.prisma.chatMessage.findUniqueOrThrow({ where: { id: body.data.id } });
    expect(row.offPlatformFlag).toBe(true);
    expect(row.message).toContain('592-600-1000'); // NOT censored
  });

  it('a normal message carries no warning and no flag', async () => {
    const res = await send("I'm at the blue gate, come through");
    expect(res.statusCode).toBe(200);
    expect(res.json().warning).toBeUndefined();
    const row = await app.prisma.chatMessage.findUniqueOrThrow({ where: { id: res.json().data.id } });
    expect(row.offPlatformFlag).toBe(false);
  });
});

// SWIFT-101: chat used to write a notification row + a socket emit by hand,
// bypassing NotificationService — so a chat message could never push and lived
// on a second, divergent notification path. It must route through the ONE path.
describe('SWIFT-101: chat notifies the recipient through NotificationService', () => {
  it('a message calls NotificationService.send for the recipient (the push path), once', async () => {
    const sendSpy = vi.spyOn(NotificationService.prototype, 'send').mockResolvedValue('notif-id');
    try {
      const res = await send('are you close?');
      expect(res.statusCode).toBe(200);
      // the OTHER participant is notified via the service — not the sender, and
      // not a bespoke row+emit that a backgrounded app never receives.
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({ userId: otherId, type: 'CHAT_MESSAGE' }),
      );
    } finally {
      sendSpy.mockRestore();
    }
  });
});
