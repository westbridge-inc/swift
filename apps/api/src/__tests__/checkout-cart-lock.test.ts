import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Prisma, UserRole } from '@prisma/client';
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
//  - F4: "sold out" on a choice is enforced by the server for every app: the
//    menu marks it, cart add refuses it with a plain message, the cart marks a
//    line whose choice sold out, and checkout refuses it — before the lock and
//    again where the order commits (with any price change since pricing).
//  - reorder: a past order comes back WITH its choices, or the line is named
//    for the customer to choose again; it never drops a choice silently.
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
      // [F4] The sold-out answer every app already recovers from: it re-reads
      // the cart, where the line is marked (see the F4 cart test).
      expect(res.json().error.code).toBe('ITEM_UNAVAILABLE');
      expect(res.json().error.message).toBe('Cheese for Lock Burger is sold out — remove it from your cart and add it again with another choice.');
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: true } });
    }
  });

  it('a line with no choices for a required group (an older cart, or a group the store added since) asks the customer to choose again', async () => {
    const c = await makeCustomer();
    const cart = await app.prisma.cart.create({ data: { customerId: c.userId, vendorId } });
    const line = await app.prisma.cartItem.create({ data: { cartId: cart.id, itemId, quantity: 1, selectedOptions: {} } });
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CART_OPTIONS_CHANGED');
    expect(res.json().error.message).toBe('Choose your options for Lock Burger again — remove it from your cart and add it from the menu.');
    // The cart says so too, and blocks the line, so the way out is visible.
    const quote = (await inject('GET', '/api/v1/customer/cart', undefined, c.token)).json().data;
    expect(quote.unavailableItemIds).toEqual([line.id]);
    expect(quote.items[0]).toMatchObject({ isAvailable: false, unavailableReason: 'Your choices need updating — remove and choose again' });
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

describe('[F4] sold out on a choice is enforced by the server, for every app', () => {
  it('cart add refuses a sold-out choice with a plain message — what an older app sends', async () => {
    const c = await makeCustomer();
    const res = await add(c.token, { selectedOptions: { [sizeGroupId]: sizeGone } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Jumbo is sold out right now. Choose another option for "Size"');
    expect(res.json().error.details).toMatchObject({ selectedOptions: ['OPTION_UNAVAILABLE'] });
    expect(await lines(c.userId)).toHaveLength(0);
  });

  it('the store menu marks the sold-out choice', async () => {
    const c = await makeCustomer();
    const res = await inject('GET', `/api/v1/customer/vendors/${vendorId}`, undefined, c.token);
    expect(res.statusCode).toBe(200);
    const burger = res.json().data.categories.flatMap((cat: { items: Array<{ id: string }> }) => cat.items)
      .find((it: { id: string }) => it.id === itemId);
    const size = burger.optionGroups.find((g: { id: string }) => g.id === sizeGroupId);
    expect(size.options.map((o: { name: string; isAvailable: boolean }) => [o.name, o.isAvailable]).sort())
      .toEqual([['Jumbo', false], ['Large', true], ['Small', true]]);
  });

  it('the cart marks a line whose choice sold out after it was added, and says why', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: plainItemId, quantity: 1 }, c.token)).statusCode).toBe(201);
    const [burgerLine, friesLine] = await lines(c.userId);
    await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: false } });
    try {
      const quote = (await inject('GET', '/api/v1/customer/cart', undefined, c.token)).json().data;
      expect(quote.unavailableItemIds).toEqual([burgerLine!.id]);
      const byId = new Map(quote.items.map((l: { id: string }) => [l.id, l]));
      expect(byId.get(burgerLine!.id)).toMatchObject({ isAvailable: false, unavailableReason: 'Cheese is sold out — remove and choose again' });
      expect(byId.get(friesLine!.id)).toMatchObject({ isAvailable: true, unavailableReason: null });
    } finally {
      await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: true } });
    }
  });

  async function pickupCart() {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    return c;
  }
  const checkoutWith = (c: { userId: string }, beforeTransaction: () => Promise<void>) =>
    new OrderService(app.prisma, app.io).checkout({
      userId: c.userId, paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' }, beforeTransaction,
    });

  it('a choice that sells out after the first check is refused where the order commits', async () => {
    const c = await pickupCart();
    try {
      await expect(checkoutWith(c, async () => {
        await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: false } });
      })).rejects.toMatchObject({ statusCode: 409, code: 'ITEM_UNAVAILABLE' });
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: true } });
    }
  });

  it('a choice repriced after the first check is refused where the order commits', async () => {
    const c = await pickupCart();
    try {
      await expect(checkoutWith(c, async () => {
        await app.prisma.option.update({ where: { id: sizeLarge }, data: { additionalPrice: 350 } });
      })).rejects.toMatchObject({ statusCode: 409, code: 'CART_CHANGED' });
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await app.prisma.option.update({ where: { id: sizeLarge }, data: { additionalPrice: 300 } });
    }
  });

  it('the item repriced after the first check is refused where the order commits', async () => {
    const c = await pickupCart();
    try {
      await expect(checkoutWith(c, async () => {
        await app.prisma.item.update({ where: { id: itemId }, data: { basePrice: BASE + 100 } });
      })).rejects.toMatchObject({ statusCode: 409, code: 'CART_CHANGED' });
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await app.prisma.item.update({ where: { id: itemId }, data: { basePrice: BASE } });
    }
  });
});

describe('[reorder] a past order comes back with its choices, or names the line to choose again', () => {
  async function pastOrder(c: { token: string }, extra?: Record<string, unknown>) {
    expect((await add(c.token, { selectedOptions: validOptions(), specialInstructions: 'No onions' })).statusCode).toBe(201);
    if (extra) expect((await inject('POST', '/api/v1/customer/cart/items', extra, c.token)).statusCode).toBe(201);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
    expect(res.statusCode).toBe(200);
    const orderId = res.json().data.orders[0].id as string;
    await app.prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
    return orderId;
  }

  it('the choices and the note come back, and the reorder checks out at the same price', async () => {
    const c = await makeCustomer();
    const orderId = await pastOrder(c);
    const res = await inject('POST', `/api/v1/customer/orders/${orderId}/reorder`, {}, c.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ itemsAdded: 1, unavailableItems: 0, needsOptions: [], message: '1 items added to cart. Ready to checkout!' });
    const [line] = await lines(c.userId);
    expect(line!.selectedOptions).toEqual({ [extrasGroupId]: [extraCheese], [sizeGroupId]: sizeLarge });
    expect(line!.specialInstructions).toBe('No onions');
    const again = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.orders[0].subtotal).toBe(BASE + 300 + 150);
  });

  it('a line whose choice has sold out is named, not added without it; the rest comes back', async () => {
    const c = await makeCustomer();
    const orderId = await pastOrder(c, { vendorId, itemId: plainItemId, quantity: 2 });
    await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: false } });
    try {
      const res = await inject('POST', `/api/v1/customer/orders/${orderId}/reorder`, {}, c.token);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        itemsAdded: 1, needsOptions: ['Lock Burger'],
        message: '1 items added to cart. Choose your options for Lock Burger again from the menu.',
      });
      expect((await lines(c.userId)).map((l) => [l.itemId, l.quantity])).toEqual([[plainItemId, 2]]);
    } finally {
      await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: true } });
    }
  });

  it('when nothing can come back with its choices, it says so and leaves the current cart alone', async () => {
    const c = await makeCustomer();
    const orderId = await pastOrder(c);
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: plainItemId, quantity: 3 }, c.token)).statusCode).toBe(201);
    await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: false } });
    try {
      const res = await inject('POST', `/api/v1/customer/orders/${orderId}/reorder`, {}, c.token);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'REORDER_NEEDS_OPTIONS', message: 'Choose your options for Lock Burger again from the menu.' });
      expect((await lines(c.userId)).map((l) => [l.itemId, l.quantity])).toEqual([[plainItemId, 3]]);
    } finally {
      await app.prisma.option.update({ where: { id: extraCheese }, data: { isAvailable: true } });
    }
  });
});

describe('[price lock] the order is placed at the prices the customer saw, or refused', () => {
  // A delivery cart priced the way the app shows it: GET /cart, then Place
  // order with that quote's total and line prices.
  async function seenCart() {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: plainItemId, quantity: 2 }, c.token)).statusCode).toBe(201);
    await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
    const quote = (await inject('GET', '/api/v1/customer/cart', undefined, c.token)).json().data;
    const seen = {
      expectedTotal: Number(quote.totalAmount),
      expectedLines: quote.items.map((l: { id: string; customerPrice: number }) => ({ lineId: l.id, unitPrice: Number(l.customerPrice) })),
    };
    const burgerLine = quote.items.find((l: { itemId: string }) => l.itemId === itemId).id as string;
    return { c, quote, seen, burgerLine };
  }
  const place = (token: string, extra: Record<string, unknown>) =>
    inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', ...extra }, token);
  const repriceBurger = (by: number) => app.prisma.item.update({ where: { id: itemId }, data: { basePrice: BASE + by } });

  it('an unchanged cart, sent with the prices the customer saw, is placed at those prices', async () => {
    const { c, quote, seen } = await seenCart();
    const res = await place(c.token, seen);
    expect(res.statusCode, res.body).toBe(200);
    expect(Number(res.json().data.orders[0].total)).toBe(Number(quote.totalAmount));
  });

  it('a price changed after the customer last saw the cart is refused with the old and new price, then placed once they confirm', async () => {
    const { c, quote, seen } = await seenCart();
    await repriceBurger(100);
    try {
      const refused = await place(c.token, seen);
      expect(refused.statusCode).toBe(409);
      const total = Number(quote.totalAmount);
      expect(refused.json().error).toMatchObject({
        code: 'PRICE_CHANGED',
        message: `Prices changed since you last looked: Lock Burger GYD 1,450 → GYD 1,550; total GYD ${total.toLocaleString('en-US')} → GYD ${(total + 100).toLocaleString('en-US')}. Review your cart and place the order again.`,
      });
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
      // The customer sees the new quote and confirms: placed at the new price.
      const fresh = (await inject('GET', '/api/v1/customer/cart', undefined, c.token)).json().data;
      expect(Number(fresh.totalAmount)).toBe(total + 100);
      const placed = await place(c.token, {
        expectedTotal: Number(fresh.totalAmount),
        expectedLines: fresh.items.map((l: { id: string; customerPrice: number }) => ({ lineId: l.id, unitPrice: Number(l.customerPrice) })),
      });
      expect(placed.statusCode, placed.body).toBe(200);
      expect(Number(placed.json().data.orders[0].total)).toBe(total + 100);
    } finally {
      await repriceBurger(0);
    }
  });

  it('a line price alone is enough to refuse (an app that sends lines without a total)', async () => {
    const { c, seen } = await seenCart();
    await app.prisma.option.update({ where: { id: sizeLarge }, data: { additionalPrice: 350 } });
    try {
      const refused = await place(c.token, { expectedLines: seen.expectedLines });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('PRICE_CHANGED');
      expect(refused.json().error.message).toBe('Prices changed since you last looked: Lock Burger GYD 1,450 → GYD 1,500. Review your cart and place the order again.');
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await app.prisma.option.update({ where: { id: sizeLarge }, data: { additionalPrice: 300 } });
    }
  });

  it('the total alone is enough to refuse (an app that sends only the total it showed)', async () => {
    const { c, seen } = await seenCart();
    await app.prisma.item.update({ where: { id: plainItemId }, data: { basePrice: 520 } });
    try {
      const refused = await place(c.token, { expectedTotal: seen.expectedTotal });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('PRICE_CHANGED');
      expect(refused.json().error.details.total).toEqual({ seen: seen.expectedTotal, now: seen.expectedTotal + 40 });
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await app.prisma.item.update({ where: { id: plainItemId }, data: { basePrice: 500 } });
    }
  });

  it('a line the customer saw that is no longer in the cart is a cart change', async () => {
    const { c, seen } = await seenCart();
    const res = await place(c.token, { expectedLines: [...seen.expectedLines, { lineId: 'gone-line', unitPrice: 500 }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CART_CHANGED');
  });

  it('a cart with more than 200 lines can still be placed with every line price the customer saw', async () => {
    // A cart has no line cap, and the apps send every line's price, so the
    // checkout body must take as many lines as a cart can hold.
    // A small-price item keeps the order under the ID-verification threshold.
    const mint = await app.prisma.item.create({ data: { vendorId, categoryId: (await app.prisma.item.findUniqueOrThrow({ where: { id: plainItemId } })).categoryId, name: 'Lock Mint', basePrice: 20, isAvailable: true } });
    const c = await makeCustomer();
    const cartRow = await app.prisma.cart.create({ data: { customerId: c.userId, vendorId } });
    await app.prisma.cartItem.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({ cartId: cartRow.id, itemId: mint.id, quantity: 1, selectedOptions: {}, specialInstructions: `line ${i + 1}` })),
    });
    await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
    const quote = (await inject('GET', '/api/v1/customer/cart', undefined, c.token)).json().data;
    expect(quote.items).toHaveLength(201);
    const res = await place(c.token, {
      expectedTotal: Number(quote.totalAmount),
      expectedLines: quote.items.map((l: { id: string; customerPrice: number }) => ({ lineId: l.id, unitPrice: Number(l.customerPrice) })),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(Number(res.json().data.orders[0].total)).toBe(Number(quote.totalAmount));
    expect(await app.prisma.orderItem.count({ where: { order: { customerId: c.userId } } })).toBe(201);
  });

  it('build 9: an app that sends no prices keeps today\'s behaviour — the order is placed at the current price', async () => {
    const { c, quote } = await seenCart();
    await repriceBurger(100);
    try {
      const res = await place(c.token, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(Number(res.json().data.orders[0].total)).toBe(Number(quote.totalAmount) + 100);
    } finally {
      await repriceBurger(0);
    }
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
    ['the delivery address text changing in place (same spot, a new door)', async (c: Awaited<ReturnType<typeof readyCart>>) => {
      await app.prisma.address.update({ where: { id: c.addressId }, data: { addressLine1: '1 Lock, Flat 9' } });
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

// Duplicate assertions are invalid input, before checkout holds any cart/store lock.
describe('expected-price request bounds', () => {
  it('duplicate line IDs do not reach the service transaction', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    const line = (await lines(c.userId))[0]!;
    let reached = false;
    await expect(new OrderService(app.prisma, app.io).checkout({
      userId: c.userId, paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' },
      expectedPrices: { lines: [{ lineId: line.id, unitPrice: 0 }, { lineId: line.id, unitPrice: 1 }] },
      beforeTransaction: async () => { reached = true; },
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_EXPECTED_PRICES' });
    expect(reached).toBe(false);
  });

  it('refuses duplicate line IDs even when their prices disagree', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    const line = (await lines(c.userId))[0]!;
    const response = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH', expectedLines: [{ lineId: line.id, unitPrice: 0 }, { lineId: line.id, unitPrice: 1 }],
    }, c.token);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
  });
});

// [L09 · price lock, Sol S3] The store's menu edits and checkout's final
// menu read are serialized: checkout locks the basket's items, option groups
// and options (stable id order) before that read, so an edit either lands
// first and the checkout sees it, or waits for the order to commit.
describe('menu changes serialize with the checkout snapshot', () => {
  type MenuEdit = (db: Prisma.TransactionClient) => Promise<unknown>;
  it.each<[string, MenuEdit, MenuEdit, string]>([
    ['a choice sold out', (db) => db.option.update({ where: { id: sizeLarge }, data: { isAvailable: false } }),
      (db) => db.option.update({ where: { id: sizeLarge }, data: { isAvailable: true } }), 'ITEM_UNAVAILABLE'],
    ['the item hidden', (db) => db.item.update({ where: { id: itemId }, data: { isAvailable: false } }),
      (db) => db.item.update({ where: { id: itemId }, data: { isAvailable: true } }), 'ITEM_UNAVAILABLE'],
    ['the item repriced', (db) => db.item.update({ where: { id: itemId }, data: { basePrice: BASE + 100 } }),
      (db) => db.item.update({ where: { id: itemId }, data: { basePrice: BASE } }), 'CART_CHANGED'],
    ['a group that now needs two choices', (db) => db.optionGroup.update({ where: { id: extrasGroupId }, data: { minSelect: 2 } }),
      (db) => db.optionGroup.update({ where: { id: extrasGroupId }, data: { minSelect: 0 } }), 'CART_OPTIONS_CHANGED'],
  ])('a store edit still in flight when checkout locks the menu (%s) is waited for, and the checkout is refused', async (_name, edit, undo, code) => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    let vendorHasRow!: () => void;
    const rowHeld = new Promise<void>((resolve) => { vendorHasRow = resolve; });
    let vendorEdit: Promise<unknown> | undefined;
    try {
      await expect(new OrderService(app.prisma, app.io).checkout({
        userId: c.userId, paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' },
        afterCartLock: async () => {
          // The store's edit holds its row and commits only after checkout has
          // reached the menu lock.
          vendorEdit = app.prisma.$transaction(async (tx) => {
            await edit(tx);
            vendorHasRow();
            await new Promise((resolve) => setTimeout(resolve, 400));
          });
          await rowHeld;
        },
      })).rejects.toMatchObject({ statusCode: 409, code });
      await vendorEdit;
      expect(await app.prisma.order.count({ where: { customerId: c.userId } })).toBe(0);
    } finally {
      await vendorEdit?.catch(() => undefined);
      await app.prisma.$transaction(async (tx) => { await undo(tx); });
    }
  });

  it('an option cannot be marked sold out after validation and before commit', async () => {
    const c = await makeCustomer();
    expect((await add(c.token, { selectedOptions: validOptions() })).statusCode).toBe(201);
    let updateBlocked = false;
    const service = new OrderService(app.prisma, app.io);
    try {
      const placed = await service.checkout({ userId: c.userId, paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' }, afterDurableTail: async () => {
        // The order is written but not committed: the store's edit must wait.
        try {
          await app.prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '300ms'");
            await tx.option.update({ where: { id: sizeLarge }, data: { isAvailable: false } });
          });
        } catch (error) {
          updateBlocked = /55P03|lock timeout/i.test(String(error));
        }
      } });
      expect(placed.orders).toHaveLength(1);
      expect(updateBlocked).toBe(true);
      // After the checkout commits the same edit completes, rather than being lost.
      await app.prisma.option.update({ where: { id: sizeLarge }, data: { isAvailable: false } });
      expect((await app.prisma.option.findUniqueOrThrow({ where: { id: sizeLarge } })).isAvailable).toBe(false);
    } finally {
      await app.prisma.option.update({ where: { id: sizeLarge }, data: { isAvailable: true } });
    }
  });
});
