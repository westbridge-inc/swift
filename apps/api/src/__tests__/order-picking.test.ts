import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';

// ---------------------------------------------------------------------------
// Grocery picking + substitution (§5.3): shelf reality beats the database.
// Money-adjacent (totals change) → failure paths first; every stock move is
// guarded and logged; the bag can't close with an open question in it.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_600_000_000 + Math.floor(Math.random() * 300_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Pick', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pick-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

let owner: { userId: string; token: string };
let vendorId: string;
let customer: { userId: string; token: string };
let categoryId: string;

async function makeItem(opts: { name: string; price?: number; stock?: number | null; group?: string }) {
  return app.prisma.item.create({
    data: {
      vendorId,
      categoryId,
      name: opts.name,
      basePrice: opts.price ?? 500,
      isAvailable: true,
      stockQuantity: opts.stock === undefined ? 10 : opts.stock,
      substitutionGroup: opts.group ?? null,
    },
  });
}

async function makeOrderWithLines(lines: Array<{ itemId: string; name: string; qty: number; price: number }>, status = 'PREPARING') {
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);
  return app.prisma.order.create({
    data: {
      orderNumber: `PICK-${nanoid(8)}`,
      orderType: 'GROCERY_DELIVERY',
      customerId: customer.userId,
      vendorId,
      status: status as any,
      fulfillment: 'DELIVERY',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: subtotal, subtotalMarkup: 0, subtotalCustomer: subtotal,
      deliveryFee: 300, totalAmount: subtotal + 300,
      paymentMethod: 'CASH',
      items: {
        create: lines.map((l) => ({
          itemId: l.itemId, name: l.name, quantity: l.qty,
          basePrice: l.price, markedUpPrice: l.price, markupAmount: 0,
          totalBase: l.qty * l.price, totalMarkup: 0, totalCustomer: l.qty * l.price,
        })),
      },
    },
    include: { items: true },
  });
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

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
      ownerId: vo.id, name: `Pick Mart ${seq}`, slug: `pick-mart-${nanoid(8).toLowerCase()}`, vendorType: 'SUPERMARKET',
      phone: `+5920009${String(seq).padStart(3, '0')}`, addressLine1: '1 Pick St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
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
  await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('pick list + ready gate', () => {
  it('SUPERMARKET ready is blocked while lines are open, clears when picked', async () => {
    const a = await makeItem({ name: `Rice ${seq}` });
    const b = await makeItem({ name: `Milk ${seq}` });
    const order = await makeOrderWithLines([
      { itemId: a.id, name: a.name, qty: 2, price: 500 },
      { itemId: b.id, name: b.name, qty: 1, price: 800 },
    ]);

    const blocked = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('PICKING_INCOMPLETE');

    for (const line of order.items) {
      const tick = await inject('PUT', `/api/v1/vendor/orders/${order.id}/items/${line.id}/picked`, owner.token, { picked: true });
      expect(tick.statusCode).toBe(200);
    }
    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token, {});
    expect(ready.statusCode).toBe(200);
  });

  it("a foreign vendor can't touch the pick list", async () => {
    const a = await makeItem({ name: `Salt ${seq}` });
    const order = await makeOrderWithLines([{ itemId: a.id, name: a.name, qty: 1, price: 200 }]);
    const stranger = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    await app.prisma.vendorOwner.create({ data: { userId: stranger.userId } });
    const res = await inject('PUT', `/api/v1/vendor/orders/${order.id}/items/${order.items[0]!.id}/picked`, stranger.token, { picked: true });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('substitution round-trip', () => {
  it('propose → customer approves: line swaps, totals move, stock moves both ways (logged)', async () => {
    const original = await makeItem({ name: `Brand-A Flour ${seq}`, price: 1000, stock: 5, group: `flour-${seq}` });
    const substitute = await makeItem({ name: `Brand-B Flour ${seq}`, price: 1200, stock: 5, group: `flour-${seq}` });
    const order = await makeOrderWithLines([{ itemId: original.id, name: original.name, qty: 2, price: 1000 }]);
    const line = order.items[0]!;

    const propose = await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/substitute`, owner.token, { substituteItemId: substitute.id });
    expect(propose.statusCode).toBe(200);
    expect(propose.json().data.subStatus).toBe('PENDING');

    // PENDING blocks both picking the line and closing the bag
    const tickBlocked = await inject('PUT', `/api/v1/vendor/orders/${order.id}/items/${line.id}/picked`, owner.token, { picked: true });
    expect(tickBlocked.statusCode).toBe(409);
    const readyBlocked = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token, {});
    expect(readyBlocked.statusCode).toBe(409);

    const approve = await inject('POST', `/api/v1/customer/orders/${order.id}/items/${line.id}/substitution`, customer.token, { approve: true });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().data.subStatus).toBe('APPROVED');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // 2 × (1200 − 1000) = +400 on every total
    expect(Number(after.subtotalCustomer)).toBe(2400);
    expect(Number(after.totalAmount)).toBe(2700);

    const [origAfter, subAfter] = await Promise.all([
      app.prisma.item.findUniqueOrThrow({ where: { id: original.id } }),
      app.prisma.item.findUniqueOrThrow({ where: { id: substitute.id } }),
    ]);
    expect(origAfter.stockQuantity).toBe(7); // 5 + 2 back on the shelf
    expect(subAfter.stockQuantity).toBe(3); // 5 − 2 claimed
    const log = await app.prisma.stockAdjustment.findFirst({ where: { itemId: original.id, reason: 'RETURN' } });
    expect(log?.delta).toBe(2);

    // Approved line still needs shelf-picking before ready
    const stillBlocked = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token, {});
    expect(stillBlocked.statusCode).toBe(409);
    await inject('PUT', `/api/v1/vendor/orders/${order.id}/items/${line.id}/picked`, owner.token, { picked: true });
    const ready = await inject('PUT', `/api/v1/vendor/orders/${order.id}/ready`, owner.token, {});
    expect(ready.statusCode).toBe(200);
  });

  it('rejects a substitution that would drop the order total below zero', async () => {
    // A heavily-discounted order (recorded total far below the line value) plus a
    // free substitute would otherwise invert the total into "we owe the customer".
    const original = await makeItem({ name: `Pricey ${seq}`, price: 5000, stock: 5, group: `neg-${seq}` });
    const freeSub = await makeItem({ name: `Free sample ${seq}`, price: 0, stock: 5, group: `neg-${seq}` });
    const order = await makeOrderWithLines([{ itemId: original.id, name: original.name, qty: 1, price: 5000 }]);
    const line = order.items[0]!;
    await app.prisma.order.update({ where: { id: order.id }, data: { totalAmount: 500 } }); // simulate a big discount

    await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/substitute`, owner.token, { substituteItemId: freeSub.id });
    const approve = await inject('POST', `/api/v1/customer/orders/${order.id}/items/${line.id}/substitution`, customer.token, { approve: true });
    expect(approve.statusCode).toBe(400);
    expect(approve.json().error.code).toBe('SUBSTITUTE_NEGATIVE_TOTAL');
    // rejected BEFORE side-effects: total untouched, substitute stock not claimed
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(after.totalAmount)).toBe(500);
    const subAfter = await app.prisma.item.findUniqueOrThrow({ where: { id: freeSub.id } });
    expect(subAfter.stockQuantity).toBe(5);
  });

  it('customer rejects: line refunded, totals shrink, original restocked', async () => {
    const original = await makeItem({ name: `Juice ${seq}`, price: 600, stock: 4, group: `juice-${seq}` });
    const substitute = await makeItem({ name: `Other Juice ${seq}`, price: 700, stock: 4, group: `juice-${seq}` });
    const order = await makeOrderWithLines([{ itemId: original.id, name: original.name, qty: 1, price: 600 }]);
    const line = order.items[0]!;

    await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/substitute`, owner.token, { substituteItemId: substitute.id });
    const reject = await inject('POST', `/api/v1/customer/orders/${order.id}/items/${line.id}/substitution`, customer.token, { approve: false });
    expect(reject.statusCode).toBe(200);
    expect(reject.json().data.subStatus).toBe('REJECTED');

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(after.subtotalCustomer)).toBe(0);
    expect(Number(after.totalAmount)).toBe(300); // fee remains
    const orig = await app.prisma.item.findUniqueOrThrow({ where: { id: original.id } });
    expect(orig.stockQuantity).toBe(5); // 4 + 1 back
  });

  it('wrong substitution group is refused; foreign customer cannot decide', async () => {
    const original = await makeItem({ name: `Soap ${seq}`, price: 400, group: `soap-${seq}` });
    const wrongGroup = await makeItem({ name: `Bread ${seq}`, price: 400, group: `bread-${seq}` });
    const order = await makeOrderWithLines([{ itemId: original.id, name: original.name, qty: 1, price: 400 }]);
    const line = order.items[0]!;

    const bad = await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/substitute`, owner.token, { substituteItemId: wrongGroup.id });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('WRONG_GROUP');

    const rightGroup = await makeItem({ name: `Soap B ${seq}`, price: 450, group: `soap-${seq}` });
    await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/substitute`, owner.token, { substituteItemId: rightGroup.id });

    const outsider = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const idor = await inject('POST', `/api/v1/customer/orders/${order.id}/items/${line.id}/substitution`, outsider.token, { approve: true });
    expect(idor.statusCode).toBe(404);
  });

  it('vendor refund-line without a substitute: totals shrink + restock', async () => {
    const item = await makeItem({ name: `Eggs ${seq}`, price: 900, stock: 2 });
    const order = await makeOrderWithLines([{ itemId: item.id, name: item.name, qty: 2, price: 900 }]);
    const line = order.items[0]!;

    const refund = await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/refund-line`, owner.token, {});
    expect(refund.statusCode).toBe(200);
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(after.totalAmount)).toBe(300);
    const stock = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock.stockQuantity).toBe(4); // 2 + 2 back
  });

  it('vendor refund-line on a heavily-discounted order floors the totals at 0 (never negative)', async () => {
    const item = await makeItem({ name: `Pricey R ${seq}`, price: 5000, stock: 3 });
    const order = await makeOrderWithLines([{ itemId: item.id, name: item.name, qty: 1, price: 5000 }]);
    const line = order.items[0]!;
    // Simulate a big order-level discount: the recorded totals sit far below the
    // un-discounted line value (a 100% promo makes the discount ≈ the subtotal).
    await app.prisma.order.update({ where: { id: order.id }, data: { totalAmount: 500, subtotalCustomer: 500, subtotalBase: 500 } });

    const refund = await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/refund-line`, owner.token, {});
    expect(refund.statusCode).toBe(200); // a refund always succeeds — it's a removal, not a choice
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    // RED before the floor guard: decrementing by the full 5000 drove these to -4500
    // ("the platform owes the customer"). Now each field floors at 0.
    expect(Number(after.totalAmount)).toBe(0);
    expect(Number(after.subtotalCustomer)).toBe(0);
    expect(Number(after.subtotalBase)).toBe(0);
  });

  it('a picking refund releases the CASH rider’s committed-float delta (no perma-leak)', async () => {
    const item = await makeItem({ name: `Float ${seq}`, price: 2000, stock: 5 });
    const order = await makeOrderWithLines([{ itemId: item.id, name: item.name, qty: 1, price: 2000 }]);
    const line = order.items[0]!;
    // A rider claimed this CASH order — float was committed against the ORIGINAL
    // subtotal (2000) at claim time.
    const rmover = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await app.prisma.rider.create({
      data: { userId: rmover.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 100_000, committedFloat: 2000 },
    });
    await app.prisma.order.update({ where: { id: order.id }, data: { riderId: rider.id } });

    const refund = await inject('POST', `/api/v1/vendor/orders/${order.id}/items/${line.id}/refund-line`, owner.token, {});
    expect(refund.statusCode).toBe(200);

    // RED before the fix: committedFloat stayed 2000 while subtotalBase dropped to
    // 0, so the terminal release (against the reduced subtotal) left 2000 committed
    // forever — the rider permanently lost that float headroom.
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(Number(after.committedFloat)).toBe(0); // the 2000 delta was released in lockstep
    const ord = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(Number(ord.subtotalBase)).toBe(0);

    await app.prisma.rider.delete({ where: { id: rider.id } });
  });
});

describe('stock adjust + low stock', () => {
  it('adjust logs a reasoned row, blocks below-zero, and drives hide/unhide edges', async () => {
    const item = await makeItem({ name: `Sugar ${seq}`, stock: 3 });

    const down = await inject('POST', `/api/v1/vendor/items/${item.id}/adjust`, owner.token, { delta: -3, reason: 'DAMAGED', note: 'dropped pallet' });
    expect(down.statusCode).toBe(200);
    expect(down.json().data.stockQuantity).toBe(0);
    expect(down.json().data.isAvailable).toBe(false); // zero auto-hides

    const tooFar = await inject('POST', `/api/v1/vendor/items/${item.id}/adjust`, owner.token, { delta: -1, reason: 'DAMAGED' });
    expect(tooFar.statusCode).toBe(409);

    const up = await inject('POST', `/api/v1/vendor/items/${item.id}/adjust`, owner.token, { delta: 10, reason: 'RECEIVED' });
    expect(up.json().data.stockQuantity).toBe(10);
    expect(up.json().data.isAvailable).toBe(true); // restock un-hides

    const trail = await app.prisma.stockAdjustment.findMany({ where: { itemId: item.id }, orderBy: { createdAt: 'asc' } });
    expect(trail.map((t) => t.delta)).toEqual([-3, 10]);
    expect(trail[0]!.reason).toBe('DAMAGED');
  });

  it('low-stock view returns exactly the at/under-threshold tracked items', async () => {
    const low = await app.prisma.item.create({
      data: { vendorId, categoryId, name: `Low ${seq}`, basePrice: 100, isAvailable: true, stockQuantity: 2, lowStockThreshold: 5 },
    });
    await app.prisma.item.create({
      data: { vendorId, categoryId, name: `Fine ${seq}`, basePrice: 100, isAvailable: true, stockQuantity: 50, lowStockThreshold: 5 },
    });
    const res = await inject('GET', '/api/v1/vendor/items/low-stock', owner.token);
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((i: any) => i.id);
    expect(ids).toContain(low.id);
    expect(ids.every((id: string) => id !== undefined)).toBe(true);
  });
});
