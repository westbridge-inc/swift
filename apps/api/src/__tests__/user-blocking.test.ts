import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { chatRoutes } from '../modules/chat/chat.routes';
import { userBlockRoutes } from '../modules/moderation/user-block.routes';

let app: FastifyInstance;
let blockerId = '';
let blockedId = '';
let blockerToken = '';
let blockedToken = '';
let otherTenantUserId = '';
let roomId = '';
let blockedMessageId = '';
const userIds: string[] = [];
const runPhoneSuffix = String(Date.now()).slice(-5);
const TENANT_B = 'launch2-block-tenant';

async function makeUser(name: string, tenantId = 'swift-default') {
  const user = await app.prisma.user.create({
    data: {
      tenantId,
      phone: `+59200987${runPhoneSuffix}${String(userIds.length).padStart(2, '0')}`,
      firstName: name,
      lastName: 'BlockTest',
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken: nanoid(48),
      deviceId: 'launch2-block-test',
      deviceType: 'test',
      authMethod: 'OTP',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { id: user.id, token };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const send = (token: string, message: string) => app.inject({
  method: 'POST',
  url: `/api/v1/chat/rooms/${roomId}/messages`,
  headers: { ...auth(token), 'content-type': 'application/json' },
  payload: { message, messageType: 'text' },
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test2';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382/14';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(chatRoutes, { prefix: '/api/v1/chat' });
  await app.register(userBlockRoutes, { prefix: '/api/v1' });
  await app.ready();

  await runWithoutTenant(() => app.prisma.tenant.upsert({
    where: { id: TENANT_B },
    update: {},
    create: { id: TENANT_B, name: 'Launch 2 block tenant', slug: TENANT_B },
  }));

  const blocker = await makeUser('Blocker');
  const blocked = await makeUser('Blocked');
  otherTenantUserId = (await makeUser('OtherTenant', TENANT_B)).id;
  blockerId = blocker.id;
  blockerToken = blocker.token;
  blockedId = blocked.id;
  blockedToken = blocked.token;

  const room = await app.prisma.chatRoom.create({
    data: {
      participants: {
        create: [
          { userId: blockerId, role: 'CUSTOMER' },
          { userId: blockedId, role: 'RIDER' },
        ],
      },
      messages: {
        create: { senderId: blockedId, message: 'A message that will be hidden after blocking.' },
      },
    },
    include: { messages: { select: { id: true } } },
  });
  roomId = room.id;
  blockedMessageId = room.messages[0]!.id;
  expect((await send(blockerToken, 'Visible before the block.')).statusCode).toBe(200);
});

afterAll(async () => {
  // UserBlock rows intentionally survive fixture teardown as audit evidence.
  // Their loose user ids preserve history after account deletion.
  await runWithoutTenant(async () => {
    await app.prisma.chatMessage.deleteMany({ where: { chatRoomId: roomId } });
    await app.prisma.chatRoomParticipant.deleteMany({ where: { chatRoomId: roomId } });
    await app.prisma.chatRoom.deleteMany({ where: { id: roomId } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

describe('reversible, server-enforced user blocking', () => {
  it('blocks the server-resolved author of a content target and is idempotent', async () => {
    const payload = { targetType: 'CHAT_MESSAGE', targetId: blockedMessageId };
    const createBlock = () => app.inject({
      method: 'POST', url: '/api/v1/blocks',
      headers: { ...auth(blockerToken), 'content-type': 'application/json' },
      payload,
    });
    const [first, duplicate] = await Promise.all([createBlock(), createBlock()]);
    expect([first.statusCode, duplicate.statusCode].sort()).toEqual([200, 201]);
    const created = first.statusCode === 201 ? first : duplicate;
    const idempotent = first.statusCode === 200 ? first : duplicate;
    expect(created.json()).toMatchObject({
      alreadyBlocked: false,
      data: { blockedUserId: blockedId, blockedUser: { firstName: 'Blocked' } },
    });
    expect(idempotent.json().alreadyBlocked).toBe(true);
    expect(idempotent.json().data.id).toBe(created.json().data.id);

    const list = await app.inject({ method: 'GET', url: '/api/v1/blocks', headers: auth(blockerToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({ blockedUserId: blockedId }),
    ]));
  });

  it('prevents contact in both directions and hides blocked history and room previews', async () => {
    const blockedSends: Array<[token: string, message: string]> = [
      [blockerToken, 'The blocker cannot send.'],
      [blockedToken, 'The blocked account cannot send back.'],
    ];
    for (const [token, message] of blockedSends) {
      const res = await send(token, message);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('USER_BLOCKED');
    }

    const history = await app.inject({
      method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: auth(blockerToken),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().contactBlocked).toBe(true);
    expect(history.json().data.some((message: { senderId: string }) => message.senderId === blockedId)).toBe(false);
    expect(history.json().data.some((message: { senderId: string }) => message.senderId === blockerId)).toBe(true);

    const rooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: auth(blockerToken) });
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json().data.some((room: { id: string }) => room.id === roomId)).toBe(false);
  });

  it('unblocks without deleting the episode, restores contact, and re-block records a new episode', async () => {
    const unblocked = await app.inject({
      method: 'PUT', url: `/api/v1/blocks/${blockedId}`,
      headers: { ...auth(blockerToken), 'content-type': 'application/json' },
      payload: { blocked: false },
    });
    expect(unblocked.statusCode).toBe(200);
    expect(unblocked.json().data).toMatchObject({ blockedUserId: blockedId, blocked: false, alreadyUnblocked: false });
    expect((await send(blockerToken, 'Contact works after reversal.')).statusCode).toBe(200);
    expect((await send(blockedToken, 'Both directions work after reversal.')).statusCode).toBe(200);
    const history = await app.inject({
      method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: auth(blockerToken),
    });
    expect(history.json().contactBlocked).toBe(false);

    const reblocked = await app.inject({
      method: 'PUT', url: `/api/v1/blocks/${blockedId}`,
      headers: { ...auth(blockerToken), 'content-type': 'application/json' },
      payload: { blocked: true },
    });
    expect(reblocked.statusCode).toBe(201);

    const episodes = await runWithoutTenant(() => app.prisma.userBlock.findMany({
      where: { blockerId, blockedId }, orderBy: { createdAt: 'asc' },
    }));
    expect(episodes).toHaveLength(2);
    expect(episodes[0]!.unblockedAt).toBeInstanceOf(Date);
    expect(episodes[1]!.unblockedAt).toBeNull();
  });

  it('rejects self/phantom block targets and never hard-deletes audit rows', async () => {
    const self = await app.inject({
      method: 'POST', url: '/api/v1/blocks',
      headers: { ...auth(blockerToken), 'content-type': 'application/json' },
      payload: { blockedUserId: blockerId },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('CANNOT_BLOCK_SELF');

    const phantom = await app.inject({
      method: 'POST', url: '/api/v1/blocks',
      headers: { ...auth(blockerToken), 'content-type': 'application/json' },
      payload: { blockedUserId: `ghost-${nanoid(6)}` },
    });
    expect(phantom.statusCode).toBe(404);

    const crossTenant = await app.inject({
      method: 'POST', url: '/api/v1/blocks',
      headers: { ...auth(blockerToken), 'content-type': 'application/json' },
      payload: { blockedUserId: otherTenantUserId },
    });
    expect(crossTenant.statusCode).toBe(404);

    await expect(app.prisma.userBlock.deleteMany({ where: { blockerId } }))
      .rejects.toThrow(/hard-delete is not permitted/);
  });
});
