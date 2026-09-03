import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { PickingService } from '../modules/order/picking.service';

// ---------------------------------------------------------------------------
// [W-28] A REJECTED OR REFUNDED LINE IS NOT A PICKED LINE.
//
// The pick-list gate asked one question — "is every line settled?" — and
// treated a refunded line and a customer-rejected substitute as settled. They
// are: nobody is waiting on a decision about them. But they have also been
// REMOVED from the order: the money came off, the stock went back. So an order
// where the store refunded every line, or the customer rejected every
// substitute, was settled on every line and contained nothing — and it could
// be marked ready, which dispatched a rider to collect an empty bag and left
// the customer paying a delivery fee for it.
//
// The clause names this exactly: "rejection requires customer substitution /
// cancellation / price resolution and cannot satisfy picked invariant".
// Readiness is now a SERVER invariant with two halves: every line settled, AND
// at least one line actually fulfilled.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let vendorId: string;
let categoryId: string;
let owner: { userId: string; token: string };
let customer: { userId: string; token: string };
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_611_000_000 + Math.floor(Math.random() * 800_000_000);

async function makeUser(roles: string[], activeRole: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Readiness',
      lastName: `U${seq}`,
      roles: roles as never,
      activeRole: activeRole as never,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `readiness-${nanoid(10)}`, deviceType: 'test', authMethod: 'OTP', expiresAt: new Date(Date.now() + 864e5) },
  });
  return { userId: user.id, token };
}

async function makeItem(name: string) {
  return app.prisma.item.create({
    data: { vendorId, categoryId, name, basePrice: 500, isAvailable: true, stockQuantity: 50 },
  });
}

async function makeOrderWithLines(lines: Array<{ itemId: string; name: string; qty: number; price: number }>) {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
  return app.prisma.order.create({
    data: {
      orderNumber: `RDY-${nanoid(8)}`,
      orderType: 'GROCERY_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status: 'PREPARING',
      fulfillment: 'DELIVERY',
      deliveryAddress: 'x',
      deliveryLat: 6.8,
      deliveryLng: -58.15,
      subtotalBase: subtotal,
      subtotalMarkup: 0,
      subtotalCustomer: subtotal,
      deliveryFee: 300,
      totalAmount: subtotal + 300,
      paymentMethod: 'CASH',
      items: {
        create: lines.map((l) => ({
          itemId: l.itemId,
          name: l.name,
          quantity: l.qty,
          basePrice: l.price,
          markedUpPrice: l.price,
          markupAmount: 0,
          totalBase: l.qty * l.price,
          totalMarkup: 0,
          totalCustomer: l.qty * l.price,
        })),
      },
    },
    include: { items: true },
  });
}

function inject(method: 'PUT' | 'POST', url: string, token: string, payload?: unknown) {
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: payload ?? {} });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name: `Readiness Mart ${seq}`,
      slug: `readiness-mart-${nanoid(8).toLowerCase()}`,
      vendorType: 'SUPERMARKET',
      phone: `+${phoneBase + 900}`,
      addressLine1: '1 Aisle St',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.801,
      longitude: -58.156,
      status: 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: true,
      isVerified: true,
    },
  });
  vendorId = vendor.id;
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Aisles', sortOrder: 0 } });
  categoryId = category.id;
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
});

afterAll(async () => {
  await app.prisma.stockAdjustment.deleteMany({ where: { item: { vendorId } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[W-28] settled is not fulfilled', () => {
  it('the predicate itself: a refunded or rejected line is settled but not fulfilled', () => {
    const picked = { picked: true, subStatus: 'NONE' };
    const approved = { picked: true, subStatus: 'APPROVED' };
    const refunded = { picked: false, subStatus: 'REFUNDED' };
    const rejected = { picked: false, subStatus: 'REJECTED' };
    const open = { picked: false, subStatus: 'NONE' };
    const pending = { picked: false, subStatus: 'PENDING' };

    for (const line of [picked, approved, refunded, rejected]) expect(PickingService.lineResolved(line)).toBe(true);
    for (const line of [open, pending]) expect(PickingService.lineResolved(line)).toBe(false);

    for (const line of [picked, approved]) expect(PickingService.lineFulfilled(line)).toBe(true);
    for (const line of [refunded, rejected, open, pending]) expect(PickingService.lineFulfilled(line)).toBe(false);
  });
});

describe('[W-28] an emptied order cannot be marked ready', () => {
  it('refunding EVERY line leaves the order settled and empty — ready is refused, and the order never leaves the store', async () => {
    const a = await makeItem(`Rice ${nanoid(4)}`);
    const b = await makeItem(`Milk ${nanoid(4)}`);
    const order = await makeOrderWithLines([
      { itemId: a.id, name: a.name, qty: 2, price: 500 },
      { itemId: b.id, name: b.name, qty: 1, price: 800 },
    ]);

    for (const line of order.items) {
      const refunded = await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/refund-line`, owner.token);
      expect(refunded.statusCode).toBe(200);
    }

    // every line is settled: the OLD gate is satisfied
    const state = await new PickingService(app.prisma, app.io).readiness(order.id);
    expect(state).toMatchObject({ total: 2, unresolved: 0, fulfilled: 0, removed: 2, ready: false });

    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token);
    expect(ready.statusCode).toBe(409);
    expect(ready.json().error.code).toBe('NOTHING_TO_HAND_OVER');
    expect(ready.json().error.message).toContain('Cancel the order');

    // and the order really did not move
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(after.status).toBe('PREPARING');
  });

  it('a customer rejecting every substitute empties the order the same way, and ready is refused', async () => {
    const a = await makeItem(`Bread ${nanoid(4)}`);
    const sub = await makeItem(`Bun ${nanoid(4)}`);
    const order = await makeOrderWithLines([{ itemId: a.id, name: a.name, qty: 1, price: 400 }]);
    const line = order.items[0]!;

    const offered = await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/substitute`, owner.token, { substituteItemId: sub.id });
    expect(offered.statusCode).toBe(200);
    const decided = await inject('POST', `/api/v1/customer/orders/${order.id}/items/${line.id}/substitution`, customer.token, { approve: false });
    expect(decided.statusCode).toBe(200);

    const stored = await app.prisma.orderItem.findUniqueOrThrow({ where: { id: line.id }, select: { subStatus: true, picked: true } });
    expect(stored.subStatus).toBe('REJECTED');
    expect(PickingService.lineResolved(stored)).toBe(true);
    expect(PickingService.lineFulfilled(stored)).toBe(false);

    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token);
    expect(ready.statusCode).toBe(409);
    expect(ready.json().error.code).toBe('NOTHING_TO_HAND_OVER');
  });

  it('one surviving line is enough: a partly emptied order IS ready, and the count is honest', async () => {
    const a = await makeItem(`Sugar ${nanoid(4)}`);
    const b = await makeItem(`Salt ${nanoid(4)}`);
    const order = await makeOrderWithLines([
      { itemId: a.id, name: a.name, qty: 1, price: 500 },
      { itemId: b.id, name: b.name, qty: 1, price: 300 },
    ]);
    const [keep, drop] = order.items;

    expect((await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${drop!.id}/refund-line`, owner.token)).statusCode).toBe(200);
    // still blocked: the surviving line has not been picked yet
    const early = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('PICKING_INCOMPLETE');

    expect((await inject('PUT', `/api/v1/vendor/orders/${order.id}/items/${keep!.id}/picked`, owner.token, { picked: true })).statusCode).toBe(200);
    const state = await new PickingService(app.prisma, app.io).readiness(order.id);
    expect(state).toMatchObject({ total: 2, unresolved: 0, fulfilled: 1, removed: 1, ready: true });

    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token);
    expect(ready.statusCode).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(after.status).toBe('READY_FOR_PICKUP');
  });

  it('an order with no lines at all is refused too — an empty bag is empty however it got that way', async () => {
    const order = await makeOrderWithLines([]);
    const state = await new PickingService(app.prisma, app.io).readiness(order.id);
    expect(state).toMatchObject({ total: 0, unresolved: 0, fulfilled: 0, removed: 0, ready: false });
    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token);
    expect(ready.statusCode).toBe(409);
    expect(ready.json().error.code).toBe('NOTHING_TO_HAND_OVER');
    expect(ready.json().error.message).toContain('no lines to hand over');
  });

  it('the ordinary path is untouched: every line picked, ready succeeds', async () => {
    const a = await makeItem(`Flour ${nanoid(4)}`);
    const order = await makeOrderWithLines([{ itemId: a.id, name: a.name, qty: 1, price: 600 }]);
    expect((await inject('PUT', `/api/v1/vendor/orders/${order.id}/items/${order.items[0]!.id}/picked`, owner.token, { picked: true })).statusCode).toBe(200);
    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token);
    expect(ready.statusCode).toBe(200);
  });

  it('the refusal is not a lockout: the vendor can still cancel the emptied order, which is the correct exit', async () => {
    const a = await makeItem(`Oil ${nanoid(4)}`);
    const order = await makeOrderWithLines([{ itemId: a.id, name: a.name, qty: 1, price: 900 }]);
    expect((await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${order.items[0]!.id}/refund-line`, owner.token)).statusCode).toBe(200);
    expect((await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token)).statusCode).toBe(409);

    const rejected = await inject('PUT', `/api/v1/vendor/orders/${order.id}/reject`, owner.token, { reason: 'Nothing left in stock for this order' });
    expect(rejected.statusCode).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    expect(after.status).toBe('CANCELLED');
  });
});
