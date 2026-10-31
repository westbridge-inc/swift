import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { StockMovementReason, UserRole } from '@prisma/client';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';
import { applyStockMovement, STOCK_REASON_ACTOR } from '../modules/inventory/stock';
import {
  approveListingWords, clearListingPhotos, countItemsOrdered, hideSoldOut, hideStoreListings, markListingProhibited,
} from '../modules/inventory/system-item-writes';
import { unhideRestocked } from '../modules/compliance/prohibited-gate';
import { catalogueCountWhere } from '../modules/partner/store-fee';
import { weekCatalogueWhere } from '../modules/billing/billing.service';
import { wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [RETIER · REVIEW-M #2259 S4-1] A store that took a listing off sale and then left it alone is not counted for it:
// a new store's fee and the weekly re-tier count a listing that is not for sale only when it CHANGED in the last 7
// days (items."updatedAt"), and a re-tier notice promises that leaving those listings alone stops the rise. So
// Swift's own writes (a customer's order, a cancelled order putting stock back, a picker, Swift's reviewers, a lapsed
// check, a wind-down, an erasure) leave the stamp where the store left it; the store's own changes still move it.
// The census of every writer is system-item-writes.unit.test.ts.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const LONG_AGO = () => new Date(Date.now() - 10 * DAY);

let app: FastifyInstance;
let orderService: OrderService;
const createdUserIds: string[] = [];
let store: { token: string; vendorId: string; categoryId: string; tenantId: string };
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200247${String(seq).padStart(2, '0')}`, firstName: 'Stamp', lastName: `User${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/stamp.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'stamp-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeCustomer() {
  const u = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: { userId: u.userId, label: 'Home', addressLine1: '1 Stamp Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true },
  });
  return u;
}

async function makeItem(name: string, opts: { stock?: number | null; forSale?: boolean; imageUrl?: string } = {}) {
  return app.prisma.item.create({
    data: {
      vendorId: store.vendorId, categoryId: store.categoryId, name, basePrice: 1000,
      stockQuantity: opts.stock ?? null, isAvailable: opts.forSale ?? true, ...(opts.imageUrl ? { imageUrl: opts.imageUrl } : {}),
    },
  });
}

/** The store's last change to this listing was 10 days ago (before any 7-day window). */
async function lastChangedLongAgo(itemId: string): Promise<Date> {
  const at = LONG_AGO();
  await app.prisma.item.update({ where: { id: itemId }, data: { updatedAt: at } });
  return (await app.prisma.item.findUniqueOrThrow({ where: { id: itemId } })).updatedAt;
}

const stampOf = async (itemId: string) => (await app.prisma.item.findUniqueOrThrow({ where: { id: itemId } })).updatedAt.getTime();

/** Is this listing in the count of the store's catalogue now (a new store's fee, and the weekly re-tier)? */
async function counted(itemId: string): Promise<{ fee: boolean; retier: boolean }> {
  const now = new Date();
  const [fee, retier] = await Promise.all([
    app.prisma.item.count({ where: { AND: [catalogueCountWhere(store.vendorId, now), { id: itemId }] } }),
    app.prisma.item.count({ where: { AND: [weekCatalogueWhere(store.vendorId, now), { id: itemId }] } }),
  ]);
  return { fee: fee === 1, retier: retier === 1 };
}
const NOT_COUNTED = { fee: false, retier: false };
const COUNTED = { fee: true, retier: true };

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  orderService = new OrderService(app.prisma, { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server);

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id, name: `Stamp Mart ${wordFreeTag(8)}`, slug: `stamp-mart-${nanoid(6)}`, vendorType: 'SUPERMARKET',
      phone: '+5920024700', addressLine1: '3 Stamp Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 } });
  store = { token: owner.token, vendorId: vendor.id, categoryId: category.id, tenantId: vendor.tenantId };
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('a customer\'s order is not the store changing its listings', () => {
  it('REVIEW-M S4-1: an order cancelled after the store took the item off sale puts the stock back without counting it', async () => {
    const customer = await makeCustomer();
    const item = await makeItem('Shelved Sardines', { stock: 3 });
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId: store.vendorId, itemId: item.id, quantity: 1 }, customer.token)).statusCode).toBeLessThan(300);
    const placed = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, customer.token);
    expect(placed.statusCode).toBe(200);
    const orderId = placed.json().data.orders[0].id as string;

    // The store takes it off sale (its own change), long before the count: then leaves it alone.
    const off = await inject('PUT', `/api/v1/vendor/items/${item.id}/availability`, { isAvailable: false }, store.token);
    expect(off.statusCode).toBe(200);
    const left = await lastChangedLongAgo(item.id);
    expect(await counted(item.id)).toEqual(NOT_COUNTED);

    await orderService.updateStatus(orderId, 'CANCELLED', 'vendor-test', 'customer changed their mind');

    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.stockQuantity).toBe(3); // the stock came back
    expect(after.isAvailable).toBe(false); // the store's own hide stands
    expect(after.updatedAt.getTime()).toBe(left.getTime()); // and the store did not change it
    expect(await counted(item.id)).toEqual(NOT_COUNTED);
  });

  it('a sale that takes the last unit hides it without stamping it; the order counter still counts; a cancel re-shows it, unstamped', async () => {
    const customer = await makeCustomer();
    const item = await makeItem('Last Loaf', { stock: 1 });
    const left = await lastChangedLongAgo(item.id);
    expect((await inject('POST', '/api/v1/customer/cart/items', { vendorId: store.vendorId, itemId: item.id, quantity: 1 }, customer.token)).statusCode).toBeLessThan(300);
    const placed = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, customer.token);
    expect(placed.statusCode).toBe(200);

    const sold = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(sold.stockQuantity).toBe(0);
    expect(sold.isAvailable).toBe(false);
    expect(sold.autoHiddenAt).not.toBeNull();
    expect(sold.totalOrdered).toBe(1);
    expect(sold.updatedAt.getTime()).toBe(left.getTime());
    expect(await counted(item.id)).toEqual(NOT_COUNTED);

    await orderService.updateStatus(placed.json().data.orders[0].id as string, 'CANCELLED', 'vendor-test', 'out of hours');
    const back = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(back.isAvailable).toBe(true);
    expect(back.autoHiddenAt).toBeNull();
    expect(back.updatedAt.getTime()).toBe(left.getTime());
  });
});

describe('the stock writer stamps only the store\'s own movements', () => {
  const reasons = Object.keys(STOCK_REASON_ACTOR) as StockMovementReason[];

  it('a sale, a cancelled order\'s restock and a picker\'s movements leave a listing that is not for sale uncounted; the store\'s own movements count it', async () => {
    for (const reason of reasons) {
      for (const delta of [1, -1]) {
        const item = await makeItem(`Moved ${reason} ${delta}`, { stock: 5, forSale: false });
        const left = await lastChangedLongAgo(item.id);
        await app.prisma.$transaction((tx) => applyStockMovement(tx, { itemId: item.id, delta, reason }));
        const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
        expect(after.stockQuantity, `${reason} ${delta}`).toBe(5 + delta);
        if (STOCK_REASON_ACTOR[reason] === 'SYSTEM') {
          expect(after.updatedAt.getTime(), `${reason} ${delta}`).toBe(left.getTime());
          expect(await counted(item.id), `${reason} ${delta}`).toEqual(NOT_COUNTED);
        } else {
          expect(after.updatedAt.getTime(), `${reason} ${delta}`).toBeGreaterThan(Date.now() - 60_000);
          expect(await counted(item.id), `${reason} ${delta}`).toEqual(COUNTED);
        }
      }
    }
  });

  it('the store\'s own stock adjust through its route still counts a listing it took off sale', async () => {
    const item = await makeItem('Adjusted Achar', { stock: 4, forSale: false });
    await lastChangedLongAgo(item.id);
    const res = await inject('POST', `/api/v1/vendor/items/${item.id}/adjust`, { delta: 2, reason: 'RECEIVED' }, store.token);
    expect(res.statusCode).toBe(200);
    expect(await counted(item.id)).toEqual(COUNTED);
  });

  it('the decrement still refuses more than the shelf holds, and moves nothing', async () => {
    const item = await makeItem('Scarce Saltfish', { stock: 1 });
    const left = await lastChangedLongAgo(item.id);
    await expect(app.prisma.$transaction((tx) => applyStockMovement(tx, { itemId: item.id, delta: -2, reason: 'SALE' })))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.stockQuantity).toBe(1);
    expect(after.updatedAt.getTime()).toBe(left.getTime());
  });
});

describe('every one of Swift\'s writes does its job and leaves the stamp where the store left it', () => {
  it('hideSoldOut hides only a listing for sale at zero', async () => {
    const empty = await makeItem('Empty Eddoes', { stock: 0 });
    const stocked = await makeItem('Stocked Sorrel', { stock: 2 });
    const leftEmpty = await lastChangedLongAgo(empty.id);
    const leftStocked = await lastChangedLongAgo(stocked.id);
    expect(await hideSoldOut(app.prisma, empty.id)).toBe(1);
    expect(await hideSoldOut(app.prisma, stocked.id)).toBe(0);
    const e = await app.prisma.item.findUniqueOrThrow({ where: { id: empty.id } });
    expect([e.isAvailable, e.autoHiddenAt !== null, e.updatedAt.getTime()]).toEqual([false, true, leftEmpty.getTime()]);
    expect(Math.abs(e.autoHiddenAt!.getTime() - Date.now())).toBeLessThan(60_000); // a true moment, whatever the session's zone
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: stocked.id } })).isAvailable).toBe(true);
    expect(await stampOf(stocked.id)).toBe(leftStocked.getTime());
    expect(await counted(empty.id)).toEqual(NOT_COUNTED);
  });

  it('countItemsOrdered counts each listing once per call', async () => {
    const item = await makeItem('Counted Cassava', { forSale: false });
    const left = await lastChangedLongAgo(item.id);
    expect(await countItemsOrdered(app.prisma, [item.id, item.id])).toBe(1);
    expect(await countItemsOrdered(app.prisma, [])).toBe(0);
    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.totalOrdered, after.updatedAt.getTime()]).toEqual([1, left.getTime()]);
  });

  it('unhideRestocked re-shows only a stock-engine hide with stock (an owner\'s hide stays)', async () => {
    const auto = await makeItem('Auto Ackee', { stock: 2, forSale: false });
    await app.prisma.item.update({ where: { id: auto.id }, data: { autoHiddenAt: new Date() } });
    const manual = await makeItem('Owner Okra', { stock: 2, forSale: false });
    const leftAuto = await lastChangedLongAgo(auto.id);
    const leftManual = await lastChangedLongAgo(manual.id);
    await unhideRestocked(app.prisma, [auto.id, manual.id]);
    const a = await app.prisma.item.findUniqueOrThrow({ where: { id: auto.id } });
    expect([a.isAvailable, a.autoHiddenAt, a.updatedAt.getTime()]).toEqual([true, null, leftAuto.getTime()]);
    const m = await app.prisma.item.findUniqueOrThrow({ where: { id: manual.id } });
    expect([m.isAvailable, m.updatedAt.getTime()]).toEqual([false, leftManual.getTime()]);
    expect(await counted(manual.id)).toEqual(NOT_COUNTED);
  });

  it('hideStoreListings takes a store\'s listings off sale (all of them, or only those for sale) without stamping any', async () => {
    const onSale = await makeItem('Lapsed Lime');
    const hidden = await makeItem('Already Hidden Hops', { forSale: false });
    const leftOn = await lastChangedLongAgo(onSale.id);
    const leftHidden = await lastChangedLongAgo(hidden.id);
    expect(await hideStoreListings(app.prisma, [store.vendorId], { onlyForSale: true })).toBeGreaterThanOrEqual(1);
    expect(await hideStoreListings(app.prisma, [store.vendorId], { onlyForSale: false })).toBeGreaterThanOrEqual(2);
    expect(await hideStoreListings(app.prisma, [], { onlyForSale: false })).toBe(0);
    for (const [id, left] of [[onSale.id, leftOn], [hidden.id, leftHidden]] as const) {
      const after = await app.prisma.item.findUniqueOrThrow({ where: { id } });
      expect([after.isAvailable, after.updatedAt.getTime()]).toEqual([false, left.getTime()]);
      expect(await counted(id)).toEqual(NOT_COUNTED);
    }
  });

  it('clearListingPhotos clears every photo address without stamping', async () => {
    const item = await makeItem('Pictured Pine', { forSale: false, imageUrl: '/uploads/items/pine.jpg' });
    const left = await lastChangedLongAgo(item.id);
    expect(await clearListingPhotos(app.prisma, store.vendorId)).toBeGreaterThanOrEqual(1);
    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.imageUrl, after.updatedAt.getTime()]).toEqual([null, left.getTime()]);
  });

  it('markListingProhibited removes once, only in its tenant, without stamping', async () => {
    const item = await makeItem('Banned Brew');
    const left = await lastChangedLongAgo(item.id);
    expect(await markListingProhibited(app.prisma, { itemId: item.id, tenantId: `${store.tenantId}-other`, prohibitedClass: 'ALCOHOL', reason: 'x' })).toBe(0);
    expect(await markListingProhibited(app.prisma, { itemId: item.id, tenantId: store.tenantId, prohibitedClass: 'ALCOHOL', reason: 'spirits' })).toBe(1);
    expect(await markListingProhibited(app.prisma, { itemId: item.id, tenantId: store.tenantId, prohibitedClass: 'ALCOHOL', reason: 'again' })).toBe(0);
    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.isAvailable, after.prohibitedClass, after.prohibitedReason, after.updatedAt.getTime()]).toEqual([false, 'ALCOHOL', 'spirits', left.getTime()]);
    expect(Math.abs(after.prohibitedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(await counted(item.id)).toEqual(NOT_COUNTED);
  });

  it('approveListingWords records the reviewer\'s approval without stamping', async () => {
    const item = await makeItem('Held Hassar', { forSale: false });
    const left = await lastChangedLongAgo(item.id);
    const hash = 'a'.repeat(64);
    expect(await approveListingWords(app.prisma, { itemId: item.id, tenantId: `${store.tenantId}-other`, wordsHash: hash })).toBe(0);
    expect(await approveListingWords(app.prisma, { itemId: item.id, tenantId: store.tenantId, wordsHash: hash })).toBe(1);
    const after = await app.prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect([after.reviewApprovedHash, after.updatedAt.getTime()]).toEqual([hash, left.getTime()]);
    expect(Math.abs(after.reviewApprovedAt!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(await counted(item.id)).toEqual(NOT_COUNTED);
  });
});
