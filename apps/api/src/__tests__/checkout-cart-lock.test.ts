import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { OrderService } from '../modules/order/order.service';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [L09 · M022 / M023 / row 70] What the customer reviewed is what is ordered.
//  - M022: options, item notes and the destination are part of the locked
//    cart; a change between pricing and commit refuses the checkout.
//  - M023: ONE option validator for cart add, cart update and checkout:
//    required groups, unavailable or duplicate choices, too many choices and
//    choices filed under the wrong group are refused; a valid set is priced
//    exactly.
//  - row 70: an item note is part of a cart line's identity — the same item
//    with a different note is its own line, never silently dropped.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_640_000_000 + Math.floor(Math.random() * 300_000_000);
let vendorId: string;
let itemId: string;
let plainItemId: string;
let sizeGroupId: string;
let sizeSmall: string;
let sizeLarge: string;
let sizeGone: string;
let extrasGroupId: string;
let extraCheese: string;
let extraEgg: string;
let extraBacon: string;
const BASE = 1000;

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Lock', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'lock', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Lock', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8014, longitude: -58.1552, isDefault: true } });
  // Same coordinates, different door: a destination change the fee would not reveal.
  const other = await app.prisma.address.create({ data: { userId: user.id, label: 'Flat 2', addressLine1: '1 Lock, Flat 2', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8014, longitude: -58.1552, isDefault: false } });
  return { userId: user.id, token, addressId: addr.id, otherAddressId: other.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

const add = (token: string, body: Record<string, unknown>) =>
  inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1, ...body }, token);

const validOptions = () => ({ [sizeGroupId]: sizeLarge, [extrasGroupId]: [extraCheese] });

async function lines(userId: string) {
  return app.prisma.cartItem.findMany({ where: { cart: { customerId: userId } }, orderBy: { createdAt: 'asc' } });
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
  await app.ready();

  const ownerUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 900}`, firstName: 'Lock', lastName: 'Vend', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Lock Diner', slug: `lock-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 901}`, addressLine1: '1 Lock', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Lock Burger', basePrice: BASE, isAvailable: true } });
  itemId = item.id;
  const plain = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Lock Fries', basePrice: 500, isAvailable: true } });
  plainItemId = plain.id;
  const size = await app.prisma.optionGroup.create({ data: { itemId, name: 'Size', isRequired: true, minSelect: 1, maxSelect: 1 } });
  sizeGroupId = size.id;
  sizeSmall = (await app.prisma.option.create({ data: { optionGroupId: size.id, name: 'Small', additionalPrice: 0 } })).id;
  sizeLarge = (await app.prisma.option.create({ data: { optionGroupId: size.id, name: 'Large', additionalPrice: 300 } })).id;
  sizeGone = (await app.prisma.option.create({ data: { optionGroupId: size.id, name: 'Jumbo', additionalPrice: 600, isAvailable: false } })).id;
  const extras = await app.prisma.optionGroup.create({ data: { itemId, name: 'Extras', isRequired: false, minSelect: 0, maxSelect: 2 } });
  extrasGroupId = extras.id;
  extraCheese = (await app.prisma.option.create({ data: { optionGroupId: extras.id, name: 'Cheese', additionalPrice: 150 } })).id;
  extraEgg = (await app.prisma.option.create({ data: { optionGroupId: extras.id, name: 'Egg', additionalPrice: 100 } })).id;
  extraBacon = (await app.prisma.option.create({ data: { optionGroupId: extras.id, name: 'Bacon', additionalPrice: 200 } })).id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  if (vendorId) {
    await app.prisma.item.deleteMany({ where: { vendorId } });
    await app.prisma.category.deleteMany({ where: { vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  }
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('[M023] one option validator for cart add, cart update and checkout', () => {
  it.each([
    ['a required group is missing', () => ({ [extrasGroupId]: [extraCheese] }), 'OPTION_REQUIRED'],
    ['an unavailable choice', () => ({ [sizeGroupId]: sizeGone }), 'OPTION_UNAVAILABLE'],
    ['a duplicate choice', () => ({ [sizeGroupId]: sizeLarge, [extrasGroupId]: [extraCheese, extraCheese] }), 'OPTION_DUPLICATE'],
    ['too many choices', () => ({ [sizeGroupId]: sizeLarge, [extrasGroupId]: [extraCheese, extraEgg, extraBacon] }), 'OPTION_LIMIT'],
    ['a choice filed under the wrong group', () => ({ [sizeGroupId]: sizeLarge, [`not-${extrasGroupId}`]: [extraCheese] }), 'OPTION_UNKNOWN'],
    ['two sizes in a pick-one group', () => ({ [sizeGroupId]: [sizeSmall, sizeLarge] }), 'OPTION_LIMIT'],
  ])('cart add refuses %s', async (_name, options, reason) => {
    const c = await makeCustomer();
    const res = await add(c.token, { selectedOptions: options() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toMatchObject({ selectedOptions: [reason] });
    expect(await lines(c.userId)).toHaveLength(0);
  });

  it('cart update runs the same validator — an invalid edit is refused and the line is unchanged', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    const [line] = await lines(c.userId);
    const res = await inject('PUT', `/api/v1/customer/cart/items/${line!.id}`, { quantity: 1, selectedOptions: { [sizeGroupId]: sizeGone } }, c.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details).toMatchObject({ selectedOptions: ['OPTION_UNAVAILABLE'] });
    expect((await lines(c.userId))[0]!.selectedOptions).toEqual(line!.selectedOptions);
  });

  it('checkout refuses a line whose choice became unavailable after it was added', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
    await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: false } });
    try {
      const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CART_OPTIONS_CHANGED');
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: true } });
    }
  });

  it('a valid set is priced exactly and its options are snapshotted on the order', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { quantity: 2, selectedOptions: { [sizeGroupId]: sizeLarge, [extrasGroupId]: [extraCheese, extraEgg] } })).statusCode).toBe(201);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
    expect(res.statusCode).toBe(200);
    const order = res.json().data.orders[0];
    // (1000 + 300 + 150 + 100) × 2
    expect(order.subtotal).toBe(3100);
    const item = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id }, include: { selectedOptions: true } });
    expect(Number(item.totalCustomer)).toBe(3100);
    expect(item.selectedOptions.map((o) => [o.optionName, Number(o.markedUpPrice)]).sort()).toEqual([['Cheese', 150], ['Egg', 100], ['Large', 300]]);
  });
});

describe('[row 70] an item note is part of a cart line', () => {
  it('the same item and options with a different note becomes its own line; both notes survive to the order', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions(), specialInstructions: 'No onions' })).statusCode).toBe(201);
    expect((await add(c.token, { selectedOptions: validOptions(), specialInstructions: 'Extra sauce' })).statusCode).toBe(201);
    const rows = await lines(c.userId);
    expect(rows.map((r) => [r.quantity, r.specialInstructions])).toEqual([[1, 'No onions'], [1, 'Extra sauce']]);

    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
    expect(res.statusCode).toBe(200);
    const items = await app.prisma.orderItem.findMany({ where: { orderId: res.json().data.orders[0].id } });
    expect(items.map((i) => i.specialInstructions).sort()).toEqual(['Extra sauce', 'No onions']);
  });

  it('the same item, options and note merges into one line', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions(), specialInstructions: ' No onions ' })).statusCode).toBe(201);
    expect((await add(c.token, { selectedOptions: { [extrasGroupId]: [extraCheese], [sizeGroupId]: sizeLarge }, specialInstructions: 'No onions' })).statusCode).toBe(200);
    const rows = await lines(c.userId);
    expect(rows.map((r) => [r.quantity, r.specialInstructions])).toEqual([[2, 'No onions']]);
  });

  it('no note and an empty note are the same line', async () => {
    const c = await makeCustomer();
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: plainItemId, quantity: 1 }, c.token)).statusCode).toBe(201);
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: plainItemId, quantity: 1, specialInstructions: '  ' }, c.token)).statusCode).toBe(200);
    expect((await lines(c.userId)).map((r) => r.quantity)).toEqual([2]);
  });
});

describe('[M022] options, notes and destination are part of the locked cart', () => {
  async function readyCart() {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions(), specialInstructions: 'No onions' })).statusCode).toBe(201);
    await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
    return c;
  }

  it.each([
    ['an option change', async (c: Awaited<ReturnType<typeof readyCart>>) => {
      await app.prisma.cartItem.updateMany({ where: { cart: { customerId: c.userId } }, data: { selectedOptions: { [sizeGroupId]: sizeSmall } } });
    }],
    ['a note change', async (c: Awaited<ReturnType<typeof readyCart>>) => {
      await app.prisma.cartItem.updateMany({ where: { cart: { customerId: c.userId } }, data: { specialInstructions: 'Extra onions' } });
    }],
    ['a different delivery address', async (c: Awaited<ReturnType<typeof readyCart>>) => {
      await app.prisma.cart.update({ where: { customerId: c.userId }, data: { deliveryAddressId: c.otherAddressId } });
    }],
    ['the delivery address being moved', async (c: Awaited<ReturnType<typeof readyCart>>) => {
      await app.prisma.address.update({ where: { id: c.addressId }, data: { latitude: 6.8300, longitude: -58.1700 } });
    }],
  ])('%s between pricing and commit refuses the checkout', async (_name, mutate) => {
    const c = await readyCart();
    const svc = new OrderService(app.prisma, app.io);
    await expect(svc.checkout({
      userId: c.userId,
      paymentMethod: 'CASH',
      beforeTransaction: () => mutate(c),
    })).rejects.toMatchObject({ statusCode: 409, code: 'CART_CHANGED' });
    expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
  });

  it('an untouched cart still checks out', async () => {
    const c = await readyCart();
    const svc = new OrderService(app.prisma, app.io);
    const res = await svc.checkout({ userId: c.userId, paymentMethod: 'CASH' });
    expect(res.orders).toHaveLength(1);
  });
});
