import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { assertMmgFulfilmentAllowed } from '../modules/order/order.service';

// [NO-DEAD-ENDS · S1-6] A direct-MMG order the customer and the store disagree
// about is paused until a person at Swift resolves it. The store used to be
// told only "A person must resolve it before the order moves." — which person,
// and what then? The refusal now says the order is paused, that Swift support
// is reviewing it, that the store will be told when it can move, and not to
// hand anything over. (The customer's screen already says "Payment under
// review · order paused".) The 409 MMG_CLAIM_MISMATCH contract is unchanged,
// and the store's order reads already carry `mmgClaimMismatchAt` for the app.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let customerId = '';
let subId = '';
const DAY = 86_400_000;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const base = 592_046_900_000 + Math.floor(Math.random() * 90_000);
  const owner = await app.prisma.user.create({
    data: { phone: `+${base}`, firstName: 'Dispute', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(owner.id);
  vendorToken = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: owner.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'd', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Dispute Diner', slug: `dispute-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${base + 1}`, addressLine1: '5 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY),
    },
  });
  subId = sub.id;
  const cust = await app.prisma.user.create({
    data: { phone: `+${base + 2}`, firstName: 'Dispute', lastName: 'Cust', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cust.id);
  customerId = cust.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } }).catch(() => undefined);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: subId } });
  await app.prisma.subscription.deleteMany({ where: { id: subId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

function expectPausedWithNextStep(message: string) {
  expect(message).toContain("The store's and the customer's MMG payment reports don't match.");
  expect(message).not.toMatch(/The customer disputes/i);
  expect(message).toMatch(/paused/);
  expect(message).toMatch(/Swift support is reviewing it/);
  expect(message).toMatch(/told when it can move/);
  expect(message).toMatch(/hand anything over/);
}

describe('a disputed MMG order tells the store it is paused and what happens next', () => {
  it('the store accepting it (build 9: PUT /vendor/orders/:id/accept, no body) is refused with the paused sentence', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `DSP-${nanoid(8)}`, orderType: 'FOOD_DELIVERY' as never, customerId, vendorId, status: 'PENDING' as never,
        fulfillment: 'PICKUP' as never, pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15,
        deliveryAddress: 'Store', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000,
        paymentMethod: 'MOBILE_MONEY' as never, paymentStatus: 'CLAIMED' as never, mmgClaimMismatchAt: new Date(),
      },
    });

    const res = await app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${order.id}/accept`, headers: { authorization: `Bearer ${vendorToken}` } });

    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('MMG_CLAIM_MISMATCH');
    expectPausedWithNextStep(res.json().error.message);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');

    // The board read the app renders carries the flag the new screen reads.
    const board = await app.inject({ method: 'GET', url: '/api/v1/vendor/orders', headers: { authorization: `Bearer ${vendorToken}` } });
    expect(board.statusCode, board.body).toBe(200);
    const row = (board.json().data as Array<Record<string, unknown>>).find((o) => o['id'] === order.id);
    expect(row?.['mmgClaimMismatchAt']).toBeTruthy();
  });

  it('every gated step (prepare, assign, deliver) gives the same paused sentence', () => {
    for (const target of ['PREPARING', 'RIDER_ASSIGNED', 'DELIVERED'] as const) {
      try {
        assertMmgFulfilmentAllowed({ paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CLAIMED', orderType: 'FOOD_DELIVERY', mmgClaimMismatchAt: new Date() }, target);
        throw new Error(`${target} was not refused`);
      } catch (error) {
        expectPausedWithNextStep((error as Error).message);
      }
    }
  });
});
