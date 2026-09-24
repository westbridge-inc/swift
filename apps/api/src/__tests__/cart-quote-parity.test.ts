import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Order, UserRole, VendorType } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { instantOfGuyanaWallClock, guyanaDayKey } from '../utils/guyana-day';
import { DEFAULT_DELIVERY_RATES, deliveryFeeFromRates, expressDeliveryFee } from '../utils/markup';
import { canonicalBillableKm } from '../utils/billable-distance';
import { estimateDeliveryMinutes, estimateDrivingDistance } from '../utils/distance';
import { orderTotal } from '../utils/order-total';

// ---------------------------------------------------------------------------
// [E01 · E09] The cart quote and the per-vendor charge agree — on real rows.
//
// A multi-vendor cart becomes one order per vendor. The quote used to price it
// as ONE order of `cart.vendor` (the store added last): one distance, one fee,
// one minimum, a tip that stayed on an all-pickup basket, and no way to ask for
// pickup or express at all — the screen and the charge disagreed by whole
// delivery fees. The quote and checkout now share one plan-and-price
// (modules/order/cart-plans.ts) and GET /cart takes checkout's own choices.
//
// The law, checked on every accepted checkout below: each order written is the
// quoted vendor row (fulfillment, subtotal, fee, discount, tip, total) in the
// same order, the quoted total is the sum collected, and checkout's
// grandTotal and the customer's totalSpent are that same number. Refused
// checkouts write nothing.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200670';
// Three stores at different distances from one drop point, so every delivery
// fee differs under the default schedule (haversine × 1.3, canonical km).
const NEAR = { lat: 6.8015, lng: -58.1560 };
const FAR = { lat: 6.8300, lng: -58.1550 };
const THIRD = { lat: 6.7950, lng: -58.1650 };
const DROP = { lat: 6.8100, lng: -58.1700 };
const MMG_HOST = 'pay.example.com';

type Mode = 'DELIVERY' | 'PICKUP';
type Session = { userId: string; token: string };
interface QuoteRow {
  vendorId: string; name: string; fulfillment: string;
  subtotal: number; deliveryFee: number; standardDeliveryFee: number; expressSurcharge: number;
  discount: number; tipAmount: number; totalAmount: number;
  minOrderAmount: number; meetsMinimum: boolean; amountToMinimum: number;
}

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdPromoIds: string[] = [];
let seq = 0;
let savedAllowedHosts: string | undefined;

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Session> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Parity', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/parity.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'parity', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeShop(name: string, at: { lat: number; lng: number }, minOrderAmount: number, vendorType: VendorType = 'RESTAURANT') {
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `parity-${nanoid(6).toLowerCase()}`, vendorType,
      phone: `${PHONE_PREFIX}98`, addressLine1: '9 Water Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: at.lat, longitude: at.lng, deliveryRadius: 25, minOrderAmount,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      mmgPayUrl: `https://${MMG_HOST}/pay/${nanoid(6)}`,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const item = (itemName: string, basePrice: number, extra: Record<string, unknown> = {}) =>
    app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: itemName, basePrice, ...extra } });
  return { vendorId: vendor.id, name, item };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

/** The cart quote for checkout's choices, carried the way clients send them. */
function quoteUrl(choices: { express?: boolean | string; selections?: Record<string, Mode>; tipAmount?: number | string } = {}) {
  const qs = new URLSearchParams();
  if (choices.express !== undefined) qs.set('express', String(choices.express));
  if (choices.selections) qs.set('fulfillmentSelections', JSON.stringify(choices.selections));
  if (choices.tipAmount !== undefined) qs.set('tipAmount', String(choices.tipAmount));
  const s = qs.toString();
  return `/api/v1/customer/cart${s ? `?${s}` : ''}`;
}

async function quote(customer: Session, choices: Parameters<typeof quoteUrl>[0] = {}) {
  const res = await inject('GET', quoteUrl(choices), undefined, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as {
    vendors: QuoteRow[]; subtotalCustomer: number; deliveryFee: number; standardDeliveryFee: number; discount: number;
    tipAmount: number; totalAmount: number; express: boolean; expressSurcharge: number; expressTotal: number;
    meetsMinimum: boolean; minimumOrderAmount: number; deliveryDistanceKm: number; estimatedDeliveryMin: number;
    vendor: { id: string; distanceKm: number } | null; items: Array<{ id: string; vendorId: string; lineTotal: number }>;
  };
}

async function shopperAt(drop = DROP) {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: { userId: customer.userId, label: 'Home', addressLine1: '3 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: drop.lat, longitude: drop.lng, isDefault: true },
  });
  return customer;
}

async function add(customer: Session, vendorId: string, itemId: string, quantity = 1, selectedOptions?: Record<string, string>) {
  const res = await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity, ...(selectedOptions ? { selectedOptions } : {}) }, customer.token);
  expect([200, 201], res.body).toContain(res.statusCode);
}

async function setCartTip(customer: Session, amount: number) {
  const res = await inject('PUT', '/api/v1/customer/cart/tip', { amount }, customer.token);
  expect(res.statusCode, res.body).toBe(200);
}

async function checkout(customer: Session, body: Record<string, unknown>) {
  return inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', ...body }, customer.token);
}

/** The orders a checkout wrote, in the order it wrote them (its plan order). */
async function ordersOf(res: Awaited<ReturnType<typeof checkout>>): Promise<Order[]> {
  expect([200, 201], res.body).toContain(res.statusCode);
  const summaries = res.json().data.orders as Array<{ id: string }>;
  return Promise.all(summaries.map((s) => app.prisma.order.findUniqueOrThrow({ where: { id: s.id } })));
}

/** THE LAW: every order written is its quoted vendor row, the quoted total is
 *  the money collected, and grandTotal / totalSpent say the same number. */
async function expectChargeIsQuote(label: string, q: Awaited<ReturnType<typeof quote>>, res: Awaited<ReturnType<typeof checkout>>, customer: Session) {
  const orders = await ordersOf(res);
  // The money first: the total the customer was shown is the total collected,
  // and every ledger downstream of checkout carries that same number.
  const sum = (pick: (o: Order) => unknown) => orders.reduce((s, o) => s + Number(pick(o)), 0);
  expect(q.totalAmount, `${label}: quoted total = collected total`).toBe(sum((o) => o.totalAmount));
  expect(res.json().data.grandTotal, `${label}: checkout grandTotal`).toBe(q.totalAmount);
  const spent = await app.prisma.customer.findUniqueOrThrow({ where: { userId: customer.userId }, select: { totalSpent: true } });
  expect(Number(spent.totalSpent), `${label}: lifetime spend recorded`).toBe(q.totalAmount);
  expect(q.subtotalCustomer, `${label}: quoted items`).toBe(sum((o) => o.subtotalCustomer));
  expect(q.deliveryFee, `${label}: quoted fees`).toBe(sum((o) => o.deliveryFee));
  expect(q.discount, `${label}: quoted discount`).toBe(sum((o) => o.discount));
  // Then each order is its quoted row, in the quoted order.
  expect(orders.map((o) => o.vendorId), `${label}: one order per quoted store, in the quoted order`).toEqual(q.vendors.map((v) => v.vendorId));
  orders.forEach((o, i) => {
    const row = q.vendors[i]!;
    expect({
      fulfillment: o.fulfillment, subtotal: Number(o.subtotalCustomer), deliveryFee: Number(o.deliveryFee),
      discount: Number(o.discount), tipAmount: Number(o.tipAmount), totalAmount: Number(o.totalAmount),
      isExpress: o.isExpress,
    }, `${label}: order ${i} (${row.name}) is its quoted row`).toEqual({
      fulfillment: row.fulfillment, subtotal: row.subtotal, deliveryFee: row.deliveryFee,
      discount: row.discount, tipAmount: row.tipAmount, totalAmount: row.totalAmount,
      isExpress: q.express && row.fulfillment === 'DELIVERY',
    });
    expect(Number(o.totalAmount), `${label}: order ${i} adds up`).toBe(Number(o.subtotalCustomer) + Number(o.deliveryFee) + Number(o.tipAmount) - Number(o.discount));
  });
  return orders;
}

async function platformCode(tag: string, discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY', discountValue: number, extra: Record<string, unknown> = {}) {
  const promo = await app.prisma.promoCode.create({
    data: {
      code: `PAR${tag}${nanoid(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, description: `${tag} parity`, discountType, discountValue,
      applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUsesPerUser: 5, funder: 'PLATFORM', ...extra,
    },
  });
  createdPromoIds.push(promo.id);
  return promo;
}

async function storeCode(tag: string, vendorId: string, discountValue: number) {
  return platformCode(tag, 'FIXED_AMOUNT', discountValue, { vendorId, funder: 'VENDOR' });
}

async function applyToCart(customer: Session, promoId: string) {
  const cart = await app.prisma.cart.findUniqueOrThrow({ where: { customerId: customer.userId } });
  await app.prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promoId } });
}

let near: Awaited<ReturnType<typeof makeShop>>;
let far: Awaited<ReturnType<typeof makeShop>>;
let third: Awaited<ReturnType<typeof makeShop>>;
let big: Awaited<ReturnType<typeof makeShop>>;
let salon: Awaited<ReturnType<typeof makeShop>>;
let bowl: { id: string };
let bowlLargeOption: { groupId: string; optionId: string };
let side: { id: string };
let wrap: { id: string };
let roti: { id: string };
let platter: { id: string };
let haircut: { id: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  savedAllowedHosts = process.env['MMG_PAY_URL_ALLOWED_HOSTS'];
  process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = MMG_HOST;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const voIds = vos.map((v) => v.id);
    await app.prisma.promoCode.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.item.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.category.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: voIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: voIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: 'PAR' }, description: { endsWith: ' parity' } } });

  // Minimums every E01 basket meets — only E09's `big` store is set to refuse.
  near = await makeShop('Parity Near', NEAR, 1000);
  far = await makeShop('Parity Far', FAR, 2000);
  third = await makeShop('Parity Third', THIRD, 500);
  big = await makeShop('Parity Big', FAR, 5000);
  salon = await makeShop('Parity Salon', NEAR, 0, 'SERVICE');
  bowl = await near.item('Near Bowl', 1200);
  const sizes = await app.prisma.optionGroup.create({
    data: { itemId: bowl.id, name: 'Size', options: { create: [{ name: 'Large', additionalPrice: 300 }] } },
    include: { options: true },
  });
  bowlLargeOption = { groupId: sizes.id, optionId: sizes.options[0]!.id };
  side = await near.item('Near Side', 800);
  wrap = await far.item('Far Wrap', 3000);
  roti = await third.item('Third Roti', 900);
  platter = await big.item('Big Platter', 3000);
  haircut = await salon.item('Parity Cut', 2000, {
    fulfillment: 'APPOINTMENT',
    bookingConfig: { durationMinutes: 30, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })) },
  });
});

afterAll(async () => {
  if (createdUserIds.length) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  }
  if (createdPromoIds.length) await app.prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } });
  if (createdVendorIds.length) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  if (savedAllowedHosts === undefined) delete process.env['MMG_PAY_URL_ALLOWED_HOSTS'];
  else process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = savedAllowedHosts;
  await app.close();
});

// ---------------------------------------------------------------------------
// E01 — the ledger's two-store basket, every combination of checkout choices.
// ---------------------------------------------------------------------------

/** The ledger scenario: the near store's bowl (a priced option on it), then the
 *  far store's wrap — so `cart.vendor` tracks the FAR store, the exact trap the
 *  single-vendor quote fell into. */
async function twoStoreBasket() {
  const customer = await shopperAt();
  await add(customer, near.vendorId, bowl.id, 1, { [bowlLargeOption.groupId]: bowlLargeOption.optionId });
  await add(customer, far.vendorId, wrap.id, 1);
  return customer;
}

const MODE_PAIRS: Array<[Mode, Mode]> = [['DELIVERY', 'DELIVERY'], ['PICKUP', 'DELIVERY'], ['DELIVERY', 'PICKUP'], ['PICKUP', 'PICKUP']];
const TIP_CASES = [
  { tipCase: 'no tip', persisted: 0, chosen: undefined },
  { tipCase: 'the cart’s tip, inherited', persisted: 300, chosen: undefined },
  { tipCase: 'a chosen tip replacing the cart’s', persisted: 300, chosen: 500 },
  { tipCase: 'an explicit no-tip over the cart’s', persisted: 300, chosen: 0 },
] as const;
const MATRIX = MODE_PAIRS.flatMap(([nearMode, farMode]) => [false, true].flatMap((express) =>
  TIP_CASES.map((tip) => ({ nearMode, farMode, express, ...tip }))));

describe('E01 — quote == charge for the two-store basket, every choice checkout accepts', () => {
  it.each(MATRIX)('near $nearMode · far $farMode · express $express · $tipCase', async ({ nearMode, farMode, express, persisted, chosen }) => {
    const customer = await twoStoreBasket();
    if (persisted) await setCartTip(customer, persisted);
    const selections = { [near.vendorId]: nearMode, [far.vendorId]: farMode };
    const q = await quote(customer, { express, selections, ...(chosen !== undefined ? { tipAmount: chosen } : {}) });

    // Checkout is sent what a client sends: the same choices, and the tip the
    // customer chose — or, with no choice made, the tip the quote was priced
    // with (the cart's). The law: what was quoted is what is collected.
    const res = await checkout(customer, { ...(express ? { express: true } : {}), fulfillmentSelections: selections, tipAmount: chosen ?? q.tipAmount });
    await expectChargeIsQuote(`${nearMode}/${farMode}/express=${express}`, q, res, customer);

    // And the quote priced THESE choices, per store.
    expect(q.express).toBe(express);
    expect(q.vendors.map((v) => [v.vendorId, v.fulfillment])).toEqual([[near.vendorId, nearMode], [far.vendorId, farMode]]);
    expect(q.tipAmount).toBe(chosen ?? persisted);
    for (const row of q.vendors) {
      if (row.fulfillment === 'PICKUP') expect(row.deliveryFee, `${row.name} pickup`).toBe(0);
      else expect(row.deliveryFee, `${row.name} delivery`).toBe(express ? expressDeliveryFee(row.standardDeliveryFee) : row.standardDeliveryFee);
    }
    const firstDelivery = q.vendors.findIndex((v) => v.fulfillment === 'DELIVERY');
    expect(q.vendors.map((v) => v.tipAmount)).toEqual(q.vendors.map((_, i) => (i === firstDelivery ? chosen ?? persisted : 0)));
    expect(q.vendors.reduce((s, v) => s + v.totalAmount, 0)).toBe(q.totalAmount);
  });

  it('the ledger’s numbers: two different fees, their sum quoted, their sum charged — where the old quote showed only the far store’s', async () => {
    const customer = await twoStoreBasket();
    const q = await quote(customer);
    await expectChargeIsQuote('ledger', q, await checkout(customer, { tipAmount: q.tipAmount }), customer);
    const feeOf = (at: { lat: number; lng: number }) =>
      deliveryFeeFromRates(canonicalBillableKm(estimateDrivingDistance(at.lat, at.lng, DROP.lat, DROP.lng)), DEFAULT_DELIVERY_RATES);
    const [qNear, qFar] = q.vendors;
    expect(qNear!.deliveryFee).toBe(feeOf(NEAR));
    expect(qFar!.deliveryFee).toBe(feeOf(FAR));
    expect(qFar!.deliveryFee).toBeGreaterThan(qNear!.deliveryFee);
    expect(q.subtotalCustomer).toBe(1500 + 3000);
    expect(q.deliveryFee).toBe(feeOf(NEAR) + feeOf(FAR));
    expect(q.totalAmount).toBe(4500 + feeOf(NEAR) + feeOf(FAR));
    // The old quote: the whole basket at `cart.vendor` (far) — one fee.
    expect(q.totalAmount - 4500).not.toBe(feeOf(FAR));
  });

  it('with no choices at all the quote is checkout’s defaults — every store delivered, standard speed, the cart’s tip', async () => {
    const customer = await twoStoreBasket();
    await setCartTip(customer, 200);
    const q = await quote(customer);
    expect(q.express).toBe(false);
    expect(q.vendors.map((v) => v.fulfillment)).toEqual(['DELIVERY', 'DELIVERY']);
    expect(q.tipAmount).toBe(200);
    // A body with no choices and no tip lands on the same defaults.
    await expectChargeIsQuote('defaults', q, await checkout(customer, {}), customer);
  });

  it('express is exact whichever way it is asked: expressTotal on a standard quote is the express quote, is the express charge', async () => {
    const customer = await twoStoreBasket();
    const standard = await quote(customer, { express: false });
    const fast = await quote(customer, { express: true });
    expect(standard.express).toBe(false);
    expect(standard.deliveryFee).toBe(standard.standardDeliveryFee);
    expect(fast.deliveryFee).toBe(fast.standardDeliveryFee + fast.expressSurcharge);
    expect(standard.expressSurcharge).toBe(fast.expressSurcharge);
    expect(standard.expressTotal).toBe(fast.totalAmount);
    expect(fast.expressTotal).toBe(fast.totalAmount);
    await expectChargeIsQuote('express', fast, await checkout(customer, { express: true, tipAmount: fast.tipAmount }), customer);
  });

  it('the add order does not change the money: far first, then near — plans follow the first line added, totals are the same', async () => {
    const forward = await twoStoreBasket();
    const reverse = await shopperAt();
    await add(reverse, far.vendorId, wrap.id, 1);
    await add(reverse, near.vendorId, bowl.id, 1, { [bowlLargeOption.groupId]: bowlLargeOption.optionId });
    await setCartTip(forward, 300);
    await setCartTip(reverse, 300);
    const qf = await quote(forward);
    const qr = await quote(reverse);
    expect(qr.vendors.map((v) => v.vendorId)).toEqual([far.vendorId, near.vendorId]);
    expect(qr.totalAmount).toBe(qf.totalAmount);
    expect(qr.vendors[0]!.tipAmount).toBe(300); // the tip rides the first DELIVERY plan — here the far store
    await expectChargeIsQuote('reverse add order', qr, await checkout(reverse, { tipAmount: qr.tipAmount }), reverse);
  });
});

describe('E01 — promotions are priced by the one basket pricer on both sides', () => {
  async function pickupBasket() {
    const customer = await twoStoreBasket();
    return { customer, selections: { [near.vendorId]: 'PICKUP' as Mode, [far.vendorId]: 'PICKUP' as Mode } };
  }

  it('a platform percentage: the discount rounds up once on the basket and is placed goods-first, plan by plan', async () => {
    const { customer, selections } = await pickupBasket();
    const promo = await platformCode('PCT', 'PERCENTAGE', 10);
    await applyToCart(customer, promo.id);
    const q = await quote(customer, { selections });
    expect(q.discount).toBe(Math.ceil(4500 * 0.1));
    await expectChargeIsQuote('platform %', q, await checkout(customer, { fulfillmentSelections: selections, promoCode: promo.code, tipAmount: q.tipAmount }), customer);
  });

  it('a platform code larger than the first store’s goods spills into the next order — the same split quoted and charged', async () => {
    const { customer, selections } = await pickupBasket();
    const promo = await platformCode('SPILL', 'FIXED_AMOUNT', 2000);
    await applyToCart(customer, promo.id);
    const q = await quote(customer, { selections });
    expect(q.vendors.map((v) => v.discount)).toEqual([1500, 500]);
    await expectChargeIsQuote('spill', q, await checkout(customer, { fulfillmentSelections: selections, promoCode: promo.code, tipAmount: q.tipAmount }), customer);
  });

  it('a store’s own code discounts only that store’s order', async () => {
    const { customer, selections } = await pickupBasket();
    const promo = await storeCode('STORE', far.vendorId, 700);
    await applyToCart(customer, promo.id);
    const q = await quote(customer, { selections });
    expect(q.vendors.map((v) => v.discount)).toEqual([0, 700]);
    await expectChargeIsQuote('store code', q, await checkout(customer, { fulfillmentSelections: selections, promoCode: promo.code, tipAmount: q.tipAmount }), customer);
  });

  it('a store code for a store not in the basket: the quote shows no discount and checkout refuses it — nothing is charged', async () => {
    const { customer, selections } = await pickupBasket();
    const promo = await storeCode('ELSE', third.vendorId, 700);
    await applyToCart(customer, promo.id);
    const q = await quote(customer, { selections });
    expect(q.discount).toBe(0);
    const res = await checkout(customer, { fulfillmentSelections: selections, promoCode: promo.code });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PROMO_WRONG_VENDOR');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  it('a cash delivery with a code is still refused at checkout (owner: not surfaced in the quote yet) — and nothing is written', async () => {
    const customer = await twoStoreBasket();
    const promo = await platformCode('CASHD', 'FIXED_AMOUNT', 300);
    await applyToCart(customer, promo.id);
    const q = await quote(customer);
    expect(q.discount).toBe(300);
    const res = await checkout(customer, { promoCode: promo.code, tipAmount: q.tipAmount });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROMO_UNAVAILABLE_CASH_DELIVERY');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  describe('fee-dependent codes on a direct-MMG delivery, at both speeds', () => {
    async function farDelivery(promoFactory: () => Promise<{ id: string; code: string }>, express: boolean) {
      const customer = await shopperAt();
      await add(customer, far.vendorId, wrap.id, 1);
      await setCartTip(customer, 200);
      const promo = await promoFactory();
      await applyToCart(customer, promo.id);
      const standard = await quote(customer, { express: false });
      const q = express ? await quote(customer, { express: true }) : standard;
      const res = await inject('POST', '/api/v1/customer/checkout', {
        paymentMethod: 'MOBILE_MONEY', promoCode: promo.code, tipAmount: q.tipAmount, ...(express ? { express: true } : {}),
      }, customer.token);
      const orders = await expectChargeIsQuote(`MMG express=${express}`, q, res, customer);
      // The MMG instruction asks for exactly the quoted total.
      expect(res.json().data.paymentAction?.amount).toBe(q.totalAmount);
      // …and the standard quote's expressTotal already named the express charge.
      if (express) expect(standard.expressTotal).toBe(q.totalAmount);
      return { q, orders };
    }

    for (const express of [false, true]) {
      it(`free delivery removes exactly the fee charged (express ${express})`, async () => {
        const { q } = await farDelivery(() => platformCode('FREE', 'FREE_DELIVERY', 0), express);
        expect(q.discount).toBe(q.deliveryFee);
        expect(q.totalAmount).toBe(3000 + 200);
      });

      it(`a platform code larger than goods + fee stops at goods + THIS speed’s fee, never the tip (express ${express})`, async () => {
        const { q } = await farDelivery(() => platformCode('HUGE', 'FIXED_AMOUNT', 9000), express);
        expect(q.discount).toBe(3000 + q.deliveryFee);
        expect(q.totalAmount).toBe(200);
      });

      it(`a store’s own code stops at the goods — the rider’s fee is not the store’s to give (express ${express})`, async () => {
        const { q } = await farDelivery(() => storeCode('OWN', far.vendorId, 5000), express);
        expect(q.discount).toBe(3000);
        expect(q.totalAmount).toBe(q.deliveryFee + 200);
      });
    }
  });
});

describe('E01 — three stores, a booking beside goods, and a SERVICE store’s delivered goods', () => {
  it('three stores in two modes: the tip rides the first delivery plan in add order, and each order is its row', async () => {
    const customer = await shopperAt();
    await add(customer, third.vendorId, roti.id, 1);
    await add(customer, near.vendorId, side.id, 2);
    await add(customer, far.vendorId, wrap.id, 1);
    const selections: Record<string, Mode> = { [third.vendorId]: 'PICKUP', [near.vendorId]: 'DELIVERY', [far.vendorId]: 'DELIVERY' };
    const q = await quote(customer, { selections, tipAmount: 500, express: true });
    expect(q.vendors.map((v) => v.vendorId)).toEqual([third.vendorId, near.vendorId, far.vendorId]);
    expect(q.vendors.map((v) => v.tipAmount)).toEqual([0, 500, 0]);
    await expectChargeIsQuote('three stores', q, await checkout(customer, { express: true, fulfillmentSelections: selections, tipAmount: 500 }), customer);
  });

  it('three stores all collected, a platform code spilling across two of them', async () => {
    const customer = await shopperAt();
    await add(customer, third.vendorId, roti.id, 1);
    await add(customer, near.vendorId, side.id, 2);
    await add(customer, far.vendorId, wrap.id, 1);
    const promo = await platformCode('THREE', 'FIXED_AMOUNT', 1500);
    await applyToCart(customer, promo.id);
    const selections: Record<string, Mode> = { [third.vendorId]: 'PICKUP', [near.vendorId]: 'PICKUP', [far.vendorId]: 'PICKUP' };
    const q = await quote(customer, { selections });
    expect(q.vendors.map((v) => v.discount)).toEqual([900, 600, 0]);
    await expectChargeIsQuote('three spill', q, await checkout(customer, { fulfillmentSelections: selections, promoCode: promo.code, tipAmount: q.tipAmount }), customer);
  });

  it('a booking beside a delivery: the booking carries no fee and no tip, the goods carry both — as checkout writes them', async () => {
    const customer = await shopperAt();
    await add(customer, salon.vendorId, haircut.id, 1);
    await add(customer, near.vendorId, bowl.id, 1);
    await setCartTip(customer, 300);
    const q = await quote(customer);
    const [booking, goods] = q.vendors;
    expect(booking).toMatchObject({ vendorId: salon.vendorId, fulfillment: 'APPOINTMENT', deliveryFee: 0, tipAmount: 0 });
    expect(goods).toMatchObject({ vendorId: near.vendorId, fulfillment: 'DELIVERY', tipAmount: 300 });
    expect(goods!.deliveryFee).toBeGreaterThan(0);
    const [y, m, d] = guyanaDayKey(new Date(Date.now() + 2 * DAY)).split('-').map(Number);
    const slotStart = instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d!, 10, 0)));
    const res = await checkout(customer, { tipAmount: q.tipAmount, appointments: [{ itemId: haircut.id, slotStart: slotStart.toISOString() }] });
    await expectChargeIsQuote('booking + goods', q, res, customer);
  });

  it('a SERVICE store selling delivered goods is quoted the delivery fee checkout charges (the old quote said free)', async () => {
    const customer = await shopperAt();
    const kit = await salon.item('Parity Kit', 1500);
    await add(customer, salon.vendorId, kit.id, 1);
    const q = await quote(customer);
    expect(q.vendors[0]).toMatchObject({ fulfillment: 'DELIVERY' });
    expect(q.deliveryFee).toBeGreaterThan(0);
    await expectChargeIsQuote('service goods', q, await checkout(customer, { tipAmount: q.tipAmount }), customer);
  });
});

describe('E01 — a single-store cart is quoted exactly as before (older clients see the same numbers)', () => {
  it('fee, distance, ETA, tip, total, express and minimum match the pre-E01 single-store formula', async () => {
    const customer = await shopperAt();
    await add(customer, near.vendorId, bowl.id, 2);
    await setCartTip(customer, 200);
    const q = await quote(customer);
    const km = canonicalBillableKm(estimateDrivingDistance(NEAR.lat, NEAR.lng, DROP.lat, DROP.lng));
    const fee = deliveryFeeFromRates(km, DEFAULT_DELIVERY_RATES);
    const total = orderTotal({ subtotal: 2400, deliveryFee: fee, tip: 200, discount: 0 });
    expect({
      subtotalCustomer: q.subtotalCustomer, deliveryFee: q.deliveryFee, tipAmount: q.tipAmount, discount: q.discount, totalAmount: q.totalAmount,
      expressSurcharge: q.expressSurcharge, expressTotal: q.expressTotal, deliveryDistanceKm: q.deliveryDistanceKm,
      vendorDistanceKm: q.vendor?.distanceKm, estimatedDeliveryMin: q.estimatedDeliveryMin, meetsMinimum: q.meetsMinimum, minimumOrderAmount: q.minimumOrderAmount,
    }).toEqual({
      subtotalCustomer: 2400, deliveryFee: fee, tipAmount: 200, discount: 0, totalAmount: total,
      expressSurcharge: expressDeliveryFee(fee) - fee, expressTotal: total + expressDeliveryFee(fee) - fee, deliveryDistanceKm: Math.round(km * 10) / 10,
      vendorDistanceKm: Math.round(km * 10) / 10, estimatedDeliveryMin: estimateDeliveryMinutes(km), meetsMinimum: true, minimumOrderAmount: 1000,
    });
    // The mutation routes answer with the same numbers (they pass no choices).
    const tipRes = await inject('PUT', '/api/v1/customer/cart/tip', { amount: 200 }, customer.token);
    expect(tipRes.json().data.cart.totalAmount).toBe(total);
  });
});

describe('E01 — the quote refuses a choice it cannot read rather than pricing a different one', () => {
  it.each([
    ['express=1', { express: '1' }],
    ['express=yes', { express: 'yes' }],
    ['a non-JSON selection', { selectionsRaw: 'near=PICKUP' }],
    ['a mode checkout does not take', { selectionsRaw: JSON.stringify({ x: 'SHIP' }) }],
    ['a selection that is not an object', { selectionsRaw: '["PICKUP"]' }],
    ['a negative tip', { tipAmount: '-1' }],
    ['a fractional tip', { tipAmount: '12.5' }],
    ['a tip over the cap', { tipAmount: '50001' }],
  ])('%s → 400', async (_label, bad) => {
    const customer = await twoStoreBasket();
    const qs = new URLSearchParams();
    if ('express' in bad) qs.set('express', bad.express as string);
    if ('selectionsRaw' in bad) qs.set('fulfillmentSelections', bad.selectionsRaw as string);
    if ('tipAmount' in bad) qs.set('tipAmount', bad.tipAmount as string);
    const res = await inject('GET', `/api/v1/customer/cart?${qs.toString()}`, undefined, customer.token);
    expect(res.statusCode, res.body).toBe(400);
  });

  it('reads the choices exactly as the phone sends them (axios 1.x leaves ":" and "," raw inside the JSON)', async () => {
    const customer = await twoStoreBasket();
    // axios/lib/helpers/buildURL.js `encode` (1.18.0), which the mobile client uses.
    const axiosEncode = (v: string) => encodeURIComponent(v).replace(/%3A/gi, ':').replace(/%24/g, '$').replace(/%2C/gi, ',').replace(/%20/g, '+');
    const pickupAll = JSON.stringify({ [near.vendorId]: 'PICKUP', [far.vendorId]: 'PICKUP' });
    const pickupUrl = `/api/v1/customer/cart?lat=6.81&lng=-58.17&fulfillmentSelections=${axiosEncode(pickupAll)}&tipAmount=0`;
    expect(pickupUrl).toContain('%22:%22PICKUP%22,%22');
    const pickup = await inject('GET', pickupUrl, undefined, customer.token);
    expect(pickup.statusCode, pickup.body).toBe(200);
    expect(pickup.json().data.vendors.map((v: QuoteRow) => v.fulfillment)).toEqual(['PICKUP', 'PICKUP']);
    expect(pickup.json().data.totalAmount).toBe(4500);
    const fast = await inject('GET', '/api/v1/customer/cart?express=true', undefined, customer.token);
    expect(fast.json().data.express).toBe(true);
  });

  it('the string "false" is standard speed (a coercing boolean would read it as express)', async () => {
    const customer = await twoStoreBasket();
    const q = await quote(customer, { express: 'false' });
    expect(q.express).toBe(false);
    expect(q.deliveryFee).toBe(q.standardDeliveryFee);
  });
});

// ---------------------------------------------------------------------------
// E09 — a store below its own minimum is quoted early, by name, and refuses.
// ---------------------------------------------------------------------------

describe('E09 — each store’s minimum is quoted per store and enforced as quoted', () => {
  it('the near store meets its minimum, the big store is short: named per store, the basket refuses, nothing is written', async () => {
    const customer = await shopperAt();
    await add(customer, near.vendorId, bowl.id, 1);
    await add(customer, big.vendorId, platter.id, 1);
    const q = await quote(customer);
    const nearRow = q.vendors.find((v) => v.vendorId === near.vendorId)!;
    const bigRow = q.vendors.find((v) => v.vendorId === big.vendorId)!;
    expect(nearRow).toMatchObject({ subtotal: 1200, minOrderAmount: 1000, meetsMinimum: true, amountToMinimum: 0 });
    expect(bigRow).toMatchObject({ name: 'Parity Big', subtotal: 3000, minOrderAmount: 5000, meetsMinimum: false, amountToMinimum: 2000 });
    expect(q.meetsMinimum).toBe(false);
    const res = await checkout(customer, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MIN_ORDER');
    expect(res.json().error.message).toContain('Parity Big');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  it('the verdict does not depend on which store was added last, nor on the combined subtotal clearing someone’s minimum', async () => {
    // Big first, near last: `cart.vendor` is the NEAR store (minimum 1,000) —
    // the old combined check said "met" (4,200 ≥ 1,000) while big alone was short.
    const customer = await shopperAt();
    await add(customer, big.vendorId, platter.id, 1);
    await add(customer, near.vendorId, bowl.id, 1);
    const q = await quote(customer);
    expect(q.meetsMinimum).toBe(false);
    expect(q.vendors.find((v) => v.vendorId === big.vendorId)!.amountToMinimum).toBe(2000);
    // Two more bowls: combined 6,600 clears even big's 5,000 — big alone does not.
    await add(customer, near.vendorId, bowl.id, 2);
    const q2 = await quote(customer);
    expect(q2.subtotalCustomer).toBe(6600);
    expect(q2.meetsMinimum).toBe(false);
    expect(q2.vendors.find((v) => v.vendorId === big.vendorId)).toMatchObject({ meetsMinimum: false, amountToMinimum: 2000 });
    const res = await checkout(customer, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MIN_ORDER');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
  });

  it('once the short store is topped up the quote says so, and the checkout it allows is the quote', async () => {
    const customer = await shopperAt();
    await add(customer, near.vendorId, bowl.id, 1);
    await add(customer, big.vendorId, platter.id, 2);
    const q = await quote(customer);
    expect(q.meetsMinimum).toBe(true);
    expect(q.vendors.every((v) => v.meetsMinimum && v.amountToMinimum === 0)).toBe(true);
    await expectChargeIsQuote('topped up', q, await checkout(customer, { tipAmount: q.tipAmount }), customer);
  });
});
