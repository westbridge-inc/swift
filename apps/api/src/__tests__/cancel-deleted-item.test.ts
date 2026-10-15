import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

let app: FastifyInstance;
let vendor: { id: string; tenantId: string };
let categoryId: string;
const sessions: string[] = [];
const run = nanoid(10);

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  const found = await runWithoutTenant(() => app.prisma.vendor.findFirst({
    where: { status: 'ACTIVE', owner: { user: { status: 'ACTIVE' } } },
    select: { id: true, tenantId: true },
  }), 'test:cancel-deleted-item');
  if (!found) throw new Error('seeded active vendor required');
  vendor = found;
  categoryId = (await app.prisma.category.create({
    data: { vendorId: vendor.id, name: `Cancellation fixture ${run}` },
  })).id;
});

afterAll(async () => {
  // Stock movements and status logs are permanent evidence, even in tests.
  // Fixtures belong only to the disposable lane database.
  await app.prisma.session.deleteMany({ where: { id: { in: sessions } } });
  await app.close();
});

async function fixture(substitute = false) {
  const customer = await app.prisma.user.create({
    data: {
      phone: `+592008${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 1000)}`,
      firstName: 'Fixture', lastName: 'Cancellation',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    },
  });
  const token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: customer.id, token, refreshToken: nanoid(32), deviceId: run,
      deviceType: 'test', expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  sessions.push(session.id);
  const item = await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId, name: 'Deleted fixture', basePrice: 500, stockQuantity: 4 },
  });
  const live = await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId, name: 'Retained fixture', basePrice: 500, stockQuantity: 4 },
  });
  const line = { name: 'Fixture line', quantity: 2, basePrice: 500, markedUpPrice: 500, markupAmount: 0, totalBase: 1000, totalMarkup: 0, totalCustomer: 1000 };
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `L02-CANCEL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      tenantId: vendor.tenantId, customerId: customer.id, vendorId: vendor.id,
      status: 'PENDING', paymentMethod: 'CASH', paymentStatus: 'PENDING',
      deliveryAddress: 'Cancellation fixture', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000,
      items: { create: [
        { ...line, itemId: substitute ? live.id : item.id,
          ...(substitute ? { subStatus: 'APPROVED' as const, substituteItemId: item.id } : {}) },
        { ...line, itemId: live.id },
      ] },
    },
  });
  await app.prisma.item.delete({ where: { id: item.id } });
  const cancel = () => app.inject({
    method: 'POST', url: `/api/v1/customer/orders/${order.id}/cancel`,
    headers: { authorization: `Bearer ${token}` }, payload: { reason: 'Fixture cancellation' },
  });
  return { item, live, order, cancel };
}

describe('cancellation after historical item deletion', () => {
  it.each([false, true])('cancels with a missing item (substituted=%s), records the skip and restocks surviving lines', async (substitute) => {
    const { item, live, order, cancel } = await fixture(substitute);
    const response = await cancel();
    expect(response.statusCode, response.body).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CANCELLED');
    const movements = await app.prisma.stockMovement.findMany({ where: { orderId: order.id } });
    expect(movements).toHaveLength(2);
    expect(movements.find((m) => m.itemId === item.id)).toMatchObject({
      tenantId: vendor.tenantId, reason: 'CANCEL_RESTOCK', delta: 0, balanceAfter: 0,
      note: expect.stringContaining('2 unit(s) could not be put back'),
    });
    expect(movements.find((m) => m.itemId === live.id)).toMatchObject({ delta: 2, balanceAfter: 6 });
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: live.id } })).stockQuantity).toBe(6);
  });

  it('two cancellation attempts commit one transition and one set of stock evidence', async () => {
    const { order, cancel } = await fixture();
    const responses = await Promise.all([cancel(), cancel()]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await app.prisma.stockMovement.count({ where: { orderId: order.id } })).toBe(2);
    expect(await app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'CANCELLED' } })).toBe(1);
  });
});
