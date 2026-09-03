import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Support ticketing (deferred pre-launch tranche): a customer can open a
// ticket, it alerts admins, an admin resolves it and the owner is notified.
// A ticket referencing an order must belong to the opener (no order fishing).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdTicketIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_800_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Sup', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, ...(roles.includes('CUSTOMER') && { customer: { create: {} } }) } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sup', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.supportTicket.deleteMany({ where: { id: { in: createdTicketIds } } });
  await app.prisma.supportTicket.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('support ticketing', () => {
  it('a customer opens a ticket; admins are alerted; admin resolves; owner notified', async () => {
    const admin = await makeUser(['ADMIN']);
    const customer = await makeUser(['CUSTOMER']);

    const create = await inject('POST', '/api/v1/customer/support', { category: 'ORDER_ISSUE', subject: 'Wrong item delivered', message: 'I got a pizza, ordered pepperpot.' }, customer.token);
    expect(create.statusCode).toBe(200);
    const ticketId = create.json().data.id;
    createdTicketIds.push(ticketId);

    const adminNote = await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: 'New support ticket' } });
    expect(adminNote).not.toBeNull();
    expect((adminNote!.data as { ticketId?: string })?.ticketId).toBe(ticketId);

    // customer sees their ticket
    const mine = await inject('GET', '/api/v1/customer/support', undefined, customer.token);
    expect(mine.json().data.some((t: { id: string }) => t.id === ticketId)).toBe(true);

    // admin lists + resolves
    const list = await inject('GET', '/api/v1/admin/support?status=OPEN', undefined, admin.token);
    expect(list.statusCode).toBe(200);
    expect(list.json().data.tickets.some((t: { id: string }) => t.id === ticketId)).toBe(true);

    // [A-18] a close now carries a disposition; the refusal cases are graded in
    // support-safety-closure.test.ts
    const resolve = await inject('PUT', `/api/v1/admin/support/${ticketId}/resolve`, { status: 'RESOLVED', resolution: 'ACTION_TAKEN', adminNote: 'Refunded, sorry!' }, admin.token);
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().data.status).toBe('RESOLVED');

    const ownerNote = await app.prisma.notification.findFirst({ where: { userId: customer.userId, title: { contains: 'resolved' } } });
    expect(ownerNote).not.toBeNull();
  });

  it('a ticket cannot reference an order you are not on', async () => {
    const victim = await makeUser(['CUSTOMER']);
    const attacker = await makeUser(['CUSTOMER']);
    const order = await app.prisma.order.create({ data: { orderNumber: `SUP-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: victim.userId, status: 'DELIVERED', fulfillment: 'DELIVERY', pickupAddress: 'a', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'b', deliveryLat: 6.81, deliveryLng: -58.16, subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH' } });
    createdOrderIds.push(order.id);

    const res = await inject('POST', '/api/v1/customer/support', { category: 'ORDER_ISSUE', subject: 'Fishing', message: 'Not my order', orderId: order.id }, attacker.token);
    expect(res.statusCode).toBe(403);
  });

  it('a non-admin cannot list or resolve tickets', async () => {
    const customer = await makeUser(['CUSTOMER']);
    const list = await inject('GET', '/api/v1/admin/support', undefined, customer.token);
    expect(list.statusCode).toBe(403);
  });
});
