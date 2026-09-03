import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { moderationRoutes } from '../modules/moderation/moderation.routes';
import { chatRoutes } from '../modules/chat/chat.routes';

// ---------------------------------------------------------------------------
// [STORE-002] Blocking — the third leg of App Store Guideline 1.2 and Google
// Play's UGC policy.
//
// Swift already had the content filter (review-scrub), the report door
// (POST /reports) and a published contact. It had NO way to block anyone: no
// model, no route, no screen. A person could report a rider for harassment and
// be matched with them again the same evening.
//
// The two rules under test are deliberately different from each other:
//   VISIBILITY is directional — a block is not a moderation decision anyone
//   else inherits;
//   CONTACT is symmetric — a one-way rule only means the blocked party keeps
//   talking in the other direction.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const riderIds: string[] = [];
let seq = 0;

let alice = { id: '', token: '' };
let mallory = { id: '', token: '' };
let bystander = { id: '', token: '' };

async function mkUser(name: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200930${String(seq).padStart(2, '0')}`,
      firstName: name, lastName: 'Block',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: `block-${seq}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  return { id: user.id, token };
}

/** An order with both people on it, which is what a chat room hangs from. */
async function mkSharedOrder(customerId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `BLK-${nanoid(8)}`,
      orderType: 'TAXI' as never,
      customerId,
      status: 'DRIVER_EN_ROUTE' as never,
      pickupLat: 6.8, pickupLng: -58.15,
      pickupAddress: 'pickup', deliveryAddress: 'dropoff',
      deliveryLat: 6.82, deliveryLng: -58.17,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0,
      deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH' as never,
    },
  });
  orderIds.push(order.id);
  return order;
}

const post = (url: string, token: string, payload: unknown) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, payload: payload as Record<string, unknown> });
const put = (url: string, token: string) =>
  app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${token}` } });
const get = (url: string, token: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const block = (token: string, blockedUserId: string, reason?: string) =>
  post('/api/v1/blocks', token, { blockedUserId, ...(reason ? { reason } : {}) });
const unblock = (token: string, blockedUserId: string) =>
  put(`/api/v1/blocks/${blockedUserId}`, token);
const listBlocks = (token: string) => get('/api/v1/blocks', token);

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
  await app.register(moderationRoutes, { prefix: '/api/v1' });
  await app.register(chatRoutes, { prefix: '/api/v1/chat' });
  await app.ready();

  alice = await mkUser('Alice');
  mallory = await mkUser('Mallory');
  bystander = await mkUser('Bystander');
});

afterAll(async () => {
  await app.prisma.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: userIds } }, { blockedId: { in: userIds } }] } });
  await app.prisma.chatMessage.deleteMany({ where: { senderId: { in: userIds } } });
  await app.prisma.chatRoomParticipant.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.chatRoom.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('the block door (STORE-002)', () => {
  it('blocks, lists the person by NAME, and is idempotent on a second tap', async () => {
    const first = await block(alice.token, mallory.id, 'kept messaging after the trip');
    expect(first.statusCode).toBe(201);
    expect(first.json().alreadyBlocked).toBe(false);

    const list = await listBlocks(alice.token);
    expect(list.statusCode).toBe(200);
    const rows = list.json().data;
    expect(rows).toHaveLength(1);
    // A screen listing cuids is not a screen anyone can use.
    expect(rows[0].name).toBe('Mallory Block');
    expect(rows[0].userId).toBe(mallory.id);
    expect(rows[0].reason).toBe('kept messaging after the trip');

    // Second tap: the same standing block, 200 not 201, and NOT a second row.
    const again = await block(alice.token, mallory.id);
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyBlocked).toBe(true);
    expect(again.json().data.id).toBe(first.json().data.id);
    expect(await app.prisma.userBlock.count({ where: { blockerId: alice.id, blockedId: mallory.id } })).toBe(1);
  });

  it('is owner-scoped: one person\'s block list is not another\'s', async () => {
    const theirs = await listBlocks(bystander.token);
    expect(theirs.statusCode).toBe(200);
    expect(theirs.json().data).toEqual([]);
  });

  it('refuses to block yourself, and refuses an id that is nobody', async () => {
    const self = await block(alice.token, alice.id);
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('CANNOT_BLOCK_SELF');

    // A block on a non-existent id would sit in the table forever doing
    // nothing while the caller believed they were protected.
    const ghost = await block(alice.token, `cku${nanoid(20)}`);
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('USER_NOT_FOUND');
  });

  it('unblocks, keeps the row as history, and re-blocking re-dates the block instead of claiming it is old', async () => {
    const lift = await unblock(alice.token, mallory.id);
    expect(lift.statusCode).toBe(200);
    expect(lift.json().data.unblocked).toBe(true);
    expect((await listBlocks(alice.token)).json().data).toEqual([]);

    // Resolved in place, never deleted: "they blocked me then unblocked me" is
    // the shape a harassment review needs to see.
    const row = await app.prisma.userBlock.findFirstOrThrow({ where: { blockerId: alice.id, blockedId: mallory.id } });
    expect(row.unblockedAt).not.toBeNull();
    const firstBlockedAt = row.blockedAt;

    // Unblocking someone who is not blocked is a no-op success — the caller's
    // intent is satisfied either way, and a 404 would describe a row they
    // cannot see.
    const twice = await unblock(alice.token, mallory.id);
    expect(twice.statusCode).toBe(200);
    expect(twice.json().data.unblocked).toBe(false);

    // Re-block: the row is reused, so `blockedAt` MUST move. Otherwise the
    // screen dates a block placed just now to the first time these two ever
    // fell out.
    await new Promise((r) => setTimeout(r, 5));
    const reblock = await block(alice.token, mallory.id);
    expect(reblock.statusCode).toBe(201);
    const after = await app.prisma.userBlock.findFirstOrThrow({ where: { blockerId: alice.id, blockedId: mallory.id } });
    expect(after.unblockedAt).toBeNull();
    expect(after.blockedAt.getTime()).toBeGreaterThan(firstBlockedAt.getTime());
    expect(await app.prisma.userBlock.count({ where: { blockerId: alice.id, blockedId: mallory.id } })).toBe(1);
  });
});

describe('a block stops contact, in both directions (STORE-002)', () => {
  it('refuses the room, refuses the send from EITHER side, writes nothing — and leaves the transcript readable', async () => {
    const carol = await mkUser('Carol');
    const dave = await mkUser('Dave');
    const order = await mkSharedOrder(carol.id);
    // [R048-004] A room's people are the ORDER's people. Dave is the rider on
    // every order below — a participant row that the order does not back is a
    // stale row, and the authority refuses it (which is the point of the
    // finding). The second half of this test already said so; now all of it does.
    const daveRider = await app.prisma.rider.create({
      data: { userId: dave.id, riderType: 'DELIVERY' as never, vehicleType: 'MOTORCYCLE' as never, documentsVerified: true },
    });
    riderIds.push(daveRider.id);
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: daveRider.id } });

    // A room they built while on speaking terms, with one message in it.
    const room = await app.prisma.chatRoom.create({
      data: {
        orderId: order.id,
        participants: { create: [{ userId: carol.id, role: 'customer' }, { userId: dave.id, role: 'rider' }] },
      },
    });
    const before = await post(`/api/v1/chat/rooms/${room.id}/messages`, dave.token, { message: 'I am at your gate' });
    expect(before.statusCode).toBe(200);

    await block(carol.token, dave.id, 'harassment');

    // The blocked party cannot send.
    const fromDave = await post(`/api/v1/chat/rooms/${room.id}/messages`, dave.token, { message: 'answer me' });
    expect(fromDave.statusCode).toBe(403);
    expect(fromDave.json().error.code).toBe('USER_BLOCKED');

    // And neither can the BLOCKER. Contact is symmetric: a rule that only
    // silenced one side would leave Carol still in the conversation she left.
    const fromCarol = await post(`/api/v1/chat/rooms/${room.id}/messages`, carol.token, { message: 'stop' });
    expect(fromCarol.statusCode).toBe(403);
    expect(fromCarol.json().error.code).toBe('USER_BLOCKED');

    // Refused, not swallowed. A message silently dropped leaves the sender
    // believing it arrived — its own kind of harm.
    expect(await app.prisma.chatMessage.count({ where: { chatRoomId: room.id } })).toBe(1);

    // Reading still works. This is how Carol finds "I am at your gate" from
    // before she blocked him — deleting the record at the moment it matters
    // most would be worse than the contact it prevents.
    const history = await get(`/api/v1/chat/rooms/${room.id}/messages`, carol.token);
    expect(history.statusCode).toBe(200);
    expect(JSON.stringify(history.json())).toContain('I am at your gate');

    // A NEW room is refused outright, so a blocked party never gets an open
    // room they can sit and watch. This needs Dave actually ON the order as a
    // rider — a room whose only participant is the caller proves nothing.
    const order2 = await mkSharedOrder(carol.id);
    await app.prisma.order.update({ where: { id: order2.id }, data: { riderId: daveRider.id } });
    const newRoom = await post('/api/v1/chat/rooms', carol.token, { orderId: order2.id });
    expect(newRoom.statusCode).toBe(403);
    expect(newRoom.json().error.code).toBe('USER_BLOCKED');
    expect(await app.prisma.chatRoom.count({ where: { orderId: order2.id } })).toBe(0);

    // Everyone else is unaffected — one person's block is not a platform ban.
    const eve = await mkUser('Eve');
    const order3 = await mkSharedOrder(eve.id);
    await app.prisma.order.update({ where: { id: order3.id }, data: { riderId: daveRider.id } });
    const eveRoom = await app.prisma.chatRoom.create({
      data: {
        orderId: order3.id,
        participants: { create: [{ userId: eve.id, role: 'customer' }, { userId: dave.id, role: 'rider' }] },
      },
    });
    const fromDaveToEve = await post(`/api/v1/chat/rooms/${eveRoom.id}/messages`, dave.token, { message: 'on my way' });
    expect(fromDaveToEve.statusCode).toBe(200);
  });
});
