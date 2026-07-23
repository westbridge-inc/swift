import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { chatRoutes } from '../modules/chat/chat.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';

// SWIFT-034 — A→B denial file. idor-cross-user.test.ts already proves the order
// and address paths; this adds the chat and courier surfaces (appointments are
// orders, so their read/cancel are covered there). Every case: user A must not
// reach a resource that belongs to user B.

let app: FastifyInstance;
let aToken = '';
let bId = '';
let roomId = '';
let courierOrderId = '';
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_820_000_000 + Math.floor(Math.random() * 80_000_000);

async function makeUser(): Promise<{ id: string; token: string }> {
  seq += 1;
  const u = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'AB', lastName: `${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'ab', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { id: u.id, token };
}

async function makeOrder(customerId: string, orderType: 'FOOD_DELIVERY' | 'COURIER') {
  return app.prisma.order.create({
    data: {
      orderNumber: `AB-${nanoid(8)}`, orderType, customerId, status: 'ACCEPTED',
      deliveryAddress: '1 B St', deliveryLat: 6.8, deliveryLng: -58.15,
      pickupAddress: 'pickup', subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
    },
  });
}

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
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();

  const a = await makeUser();
  aToken = a.token;
  const b = await makeUser();
  bId = b.id;

  // B's chat room (B is the only participant).
  const bOrder = await makeOrder(bId, 'FOOD_DELIVERY');
  const room = await app.prisma.chatRoom.create({
    data: { orderId: bOrder.id, participants: { create: [{ userId: bId, role: 'customer' }] } },
  });
  roomId = room.id;

  // B's courier order.
  courierOrderId = (await makeOrder(bId, 'COURIER')).id;
});

afterAll(async () => {
  await app.prisma.chatRoomParticipant.deleteMany({ where: { chatRoomId: roomId } });
  await app.prisma.chatRoom.deleteMany({ where: { id: roomId } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const as = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

describe('A→B denial — chat [SWIFT-034]', () => {
  it("A cannot READ B's chat room history (not a participant)", async () => {
    const res = await as('GET', `/api/v1/chat/rooms/${roomId}/messages`, aToken);
    expect(res.statusCode).toBe(403);
  });
  it("A cannot POST into B's chat room", async () => {
    // Valid body (so it clears validation and reaches the participation check).
    const res = await as('POST', `/api/v1/chat/rooms/${roomId}/messages`, aToken, { message: 'hi' });
    expect(res.statusCode).toBe(403);
    // Nothing was written to B's room.
    expect(await app.prisma.chatMessage.count({ where: { chatRoomId: roomId } })).toBe(0);
  });
});

describe('A→B denial — courier [SWIFT-034]', () => {
  it("A cannot READ B's courier order", async () => {
    const res = await as('GET', `/api/v1/courier/order/${courierOrderId}`, aToken);
    expect(res.statusCode).toBe(404);
  });
  it("A cannot CANCEL B's courier order", async () => {
    const res = await as('POST', `/api/v1/courier/order/${courierOrderId}/cancel`, aToken, { reason: 'hijack' });
    expect(res.statusCode).toBe(404);
    // B's order is untouched.
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: courierOrderId } });
    expect(order.status).toBe('ACCEPTED');
  });
  it('a forged courier id is a clean 4xx, never a 500', async () => {
    const res = await as('GET', `/api/v1/courier/order/does-not-exist-${nanoid(6)}`, aToken);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
