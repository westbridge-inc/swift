import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { VAT_CERTIFICATE_DOC_TYPE } from '../modules/store-vat/store-vat';
import { priceWithVatAdded, reconcileVatPricing } from '../modules/store-vat/vat-pricing';
import { previewSync, confirmSync } from '../modules/inventory/pos-sync';
import { readLiveMenu, writeMenuCopy } from '../modules/vendor/menu-copy';
import { ownedVerificationFixture } from './helpers/verification-object';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { walkOrderStatus } from './helpers/order-status-walk';

// ---------------------------------------------------------------------------
// [VAT-DOCS · owner 30 Oct 2026] "Add VAT at checkout", end to end on a real database:
//   - ONE submission (the Documents list's optional VAT row): number + certificate + price mode; the store waits for a
//     PERSON and nothing a customer sees changes; a person can never approve a store without a mode;
//   - approved: from that commit every standard-rated price (and its options) = the typed price + 14%, half-up to whole
//     GYD; zero-rated / exempt prices stay as typed; the storefront, cart, checkout and receipt all show the SAME full
//     price, so the customer sees it before ordering (VAT Act s.90(2)) and the order is for exactly what was quoted;
//   - every price the store types afterwards (editor, options, file import, till sync, a copied menu) gets VAT added;
//     an older app that only knows the VAT-inclusive price can send it back unchanged but never move it;
//   - withdrawn / a new number / "no" / a mode change: every price back to what the store typed at once; a placed order
//     keeps what it froze.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RUN = wordFreeTag(6);
const REASON = `Checked the GRA certificate against the store record ${RUN}`;
const VAT_NUMBER = '023456789';

let app: FastifyInstance;
let verification: VerificationService;
const userIds: string[] = [];
const vendorIds: string[] = [];
let ownerUserId = '';
let ownerToken = '';
let reviewerToken = '';
let customer: { userId: string; token: string; addressId: string };
let vendorId = '';
let categoryId = '';
let soapId = '';
let riceId = '';
let sizeOptionId = '';
let sizeGroupId = '';
let certificateDocId = '';
let placedOrderId = '';
let itemSeq = 0;
const word = (w: string) => `${w} ${(itemSeq += 1)}`;

async function session(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vatadd-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return token;
}

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  });
}
const vendorCall = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, payload?: unknown) => call(method, `/api/v1/vendor${path}`, ownerToken, payload);
const adminCall = (path: string, payload: unknown) => call('POST', `/api/v1/admin${path}`, reviewerToken, payload, { 'x-swift-reason': REASON });
const codeOf = (res: { json: () => { error?: { code?: string }; code?: string } }) => res.json().error?.code ?? res.json().code;
const vendorRow = () => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
const itemRow = (id: string) => app.prisma.item.findUniqueOrThrow({ where: { id }, include: { optionGroups: { include: { options: true } } } });
const prices = async (id: string) => {
  const row = await itemRow(id);
  return { basePrice: Number(row.basePrice), vatListedPrice: row.vatListedPrice === null ? null : Number(row.vatListedPrice) };
};
const optionPrices = async (id: string) => {
  const row = await app.prisma.option.findUniqueOrThrow({ where: { id } });
  return { additionalPrice: Number(row.additionalPrice), vatListedAdditionalPrice: row.vatListedAdditionalPrice === null ? null : Number(row.vatListedAdditionalPrice) };
};
const storefront = async () => {
  const res = await call('GET', `/api/v1/customer/vendors/${vendorId}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { vat: unknown; categories: Array<{ items: Array<{ id: string; basePrice: number; vatClass?: string }> }> };
};
const shownPrice = async (id: string) => (await storefront()).categories.flatMap((c) => c.items).find((i) => i.id === id)?.basePrice;

async function fillCart(lines: Array<{ itemId: string; quantity: number; options?: Record<string, string> }>) {
  await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  for (const line of lines) {
    const add = await call('POST', '/api/v1/customer/cart/items', customer.token, {
      vendorId, itemId: line.itemId, quantity: line.quantity, ...(line.options ? { selectedOptions: line.options } : {}),
    });
    expect(add.statusCode, add.body).toBeLessThan(300);
  }
  const address = await call('PUT', '/api/v1/customer/cart/address', customer.token, { addressId: customer.addressId });
  expect(address.statusCode, address.body).toBeLessThan(300);
  const cart = await call('GET', '/api/v1/customer/cart', customer.token);
  expect(cart.statusCode, cart.body).toBe(200);
  return cart.json().data as { totalAmount: number; subtotalCustomer: number; vendors: Array<{ vendorId: string; totalAmount: number; vat: { included: number } | null }> };
}

function checkoutCall(extra: Record<string, unknown> = {}) {
  return call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH', ...extra }, { 'idempotency-key': `vatadd-${nanoid(10)}` });
}

const approveBody = (over: Record<string, unknown> = {}) => ({
  certificateDocId, vatNumber: VAT_NUMBER, registeredName: 'Vat Add Trading', effectiveFrom: '2026-01-01', nameMatchesStore: true, ...over,
});

/** Send the certificate with the number and the mode in ONE submission (the Documents row). */
async function sendCertificate(extra: Record<string, unknown>) {
  return vendorCall('POST', '/vat/certificate', {
    fileUrl: await ownedVerificationFixture(app.prisma, ownerUserId), consent: true, privacyNoticeVersion: 'v1', ...extra,
  });
}

async function approve() {
  certificateDocId = (await vendorRow()).vatCertificateDocId!;
  const res = await adminCall(`/store-vat/${vendorId}/approve`, approveBody());
  expect(res.statusCode, res.body).toBe(200);
  return res;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['STORE_VAT'] = '1';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), {} as never);

  const owner = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Adder', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, countryCode: 'GY', selfieCapturedAt: new Date(),
  } });
  ownerUserId = owner.id; userIds.push(owner.id);
  ownerToken = await session(owner.id, 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `Vat Add Corner ${RUN}`, slug: `vat-add-corner-${RUN.toLowerCase()}`, vendorType: 'SUPERMARKET',
    phone: testPhone(), addressLine1: '3 Vat St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
  } });
  vendorId = vendor.id; vendorIds.push(vendor.id);
  const { checklist } = await verification.activationChecklist(owner.id, 'SUPERMARKET');
  for (const docType of checklist) {
    await app.prisma.verificationDocument.create({ data: {
      userId: owner.id, role: 'VENDOR_OWNER', docType, fileUrl: `verification/${RUN}/${docType}.enc`,
      status: 'APPROVED', reviewedBy: 'seed', reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1',
    } as never });
  }
  categoryId = (await app.prisma.category.create({ data: { vendorId, name: 'Shelf', sortOrder: 0 } })).id;
  const soap = await app.prisma.item.create({ data: {
    vendorId, categoryId, name: word('Soap'), basePrice: 100, isAvailable: true, sku: `SOAP-${RUN}`,
    optionGroups: { create: [{ name: 'Size', isRequired: false, minSelect: 0, maxSelect: 1, options: { create: [{ name: 'Large', additionalPrice: 10 }] } }] },
  }, include: { optionGroups: { include: { options: true } } } });
  soapId = soap.id; sizeGroupId = soap.optionGroups[0]!.id; sizeOptionId = soap.optionGroups[0]!.options[0]!.id;
  riceId = (await app.prisma.item.create({ data: { vendorId, categoryId, name: word('Rice'), basePrice: 600, isAvailable: true, vatClass: 'ZERO_RATED' } })).id;

  const reviewer = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Checker', roles: ['SUPER_ADMIN', 'CUSTOMER'] as UserRole[], activeRole: 'SUPER_ADMIN',
    status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*', 'documents.review'] } },
  } });
  userIds.push(reviewer.id);
  reviewerToken = await session(reviewer.id, 'SUPER_ADMIN');

  const cust = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Shopper', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER',
    isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  userIds.push(cust.id);
  const addr = await app.prisma.address.create({ data: { userId: cust.id, label: 'Home', addressLine1: '4 Shopper St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
  customer = { userId: cust.id, token: await session(cust.id, 'CUSTOMER'), addressId: addr.id };
});

afterAll(async () => {
  process.env['STORE_VAT'] = '';
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: userIds } }, select: { id: true } });
  const oids = orders.map((o) => o.id);
  const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const dids = docs.map((d) => d.id);
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: oids } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: oids } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.verificationDecisionOutbox.deleteMany({ where: { documentId: { in: dids } } });
  await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: dids } } } });
  await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: dids } } });
  await app.prisma.verificationDocument.deleteMany({ where: { id: { in: dids } } });
  await app.prisma.posImport.deleteMany({ where: { vendorId: { in: vendorIds } } });
  const itemIds = (await app.prisma.item.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((i) => i.id);
  await app.prisma.stockMovement.deleteMany({ where: { itemId: { in: itemIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('0. the arithmetic: the typed price + 14%, half-up to the whole dollar; the database does exactly the same', () => {
  it('priceWithVatAdded', () => {
    expect(priceWithVatAdded(100)).toBe(114);
    expect(priceWithVatAdded(1000)).toBe(1140);
    expect(priceWithVatAdded(25)).toBe(29); // 28.50 -> half-up
    expect(priceWithVatAdded(75)).toBe(86); // 85.50 -> half-up
    expect(priceWithVatAdded(10)).toBe(11); // 11.40
    expect(priceWithVatAdded(99.99)).toBe(114); // 113.9886
    expect(priceWithVatAdded(0)).toBe(0);
    expect(() => priceWithVatAdded(-1)).toThrow(RangeError);
  });

  it('the SQL rule equals priceWithVatAdded on the half-dollar edges (no float anywhere)', async () => {
    const typed = [25, 75, 125, 0.44, 43.86, 99.99, 1234.56, 9_999_999.99];
    const rows = await app.prisma.$queryRawUnsafe<Array<{ v: string }>>(
      `SELECT ROUND(x * $1::int / 10000, 0)::text AS v FROM unnest($2::numeric[]) WITH ORDINALITY AS t(x, n) ORDER BY n`, 11400, typed.map(String),
    );
    expect(rows.map((r) => Number(r.v))).toEqual(typed.map((t) => priceWithVatAdded(t)));
  });
});

describe('1. ONE submission: number + certificate + price mode (the Documents list row)', () => {
  it('a store that never said yes must send the number AND the mode with the certificate (nothing is filed otherwise)', async () => {
    const before = await app.prisma.verificationDocument.count({ where: { userId: ownerUserId, docType: VAT_CERTIFICATE_DOC_TYPE } });
    const noMode = await sendCertificate({ vatRegistrationNumber: VAT_NUMBER });
    expect(noMode.statusCode, noMode.body).toBe(409);
    expect(codeOf(noMode)).toBe('VAT_NOT_CLAIMED');
    const badNumber = await sendCertificate({ vatRegistrationNumber: '12', mode: 'ADD_VAT_AT_CHECKOUT' });
    expect(badNumber.statusCode, badNumber.body).toBe(400);
    expect(await app.prisma.verificationDocument.count({ where: { userId: ownerUserId, docType: VAT_CERTIFICATE_DOC_TYPE } })).toBe(before);
    expect((await vendorRow()).vatStatus).toBe('NONE');
  });

  it('number + certificate + "add VAT at checkout" in one go: PENDING with all three; prices unchanged until a person approves', async () => {
    const res = await sendCertificate({ vatRegistrationNumber: VAT_NUMBER, mode: 'ADD_VAT_AT_CHECKOUT' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ status: 'PENDING', mode: 'ADD_VAT_AT_CHECKOUT', vatRegistrationNumber: VAT_NUMBER, effective: false, addsVatToPrices: false });
    expect(res.json().data.modesOffered).toEqual(expect.arrayContaining(['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT']));
    const row = await vendorRow();
    expect(row).toMatchObject({ vatStatus: 'PENDING', vatMode: 'ADD_VAT_AT_CHECKOUT', vatRegistrationNumber: VAT_NUMBER });
    expect(row.vatCertificateDocId).toBeTruthy();
    expect(await prices(soapId)).toEqual({ basePrice: 100, vatListedPrice: null });
    expect(await shownPrice(soapId)).toBe(100);
    expect((await storefront()).vat).toBeNull();
  });

  it('a person can never approve a store without a pricing mode (409 VAT_MODE_REQUIRED), whatever an older app left', async () => {
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { vatMode: null } });
    try {
      certificateDocId = (await vendorRow()).vatCertificateDocId!;
      const res = await adminCall(`/store-vat/${vendorId}/approve`, approveBody());
      expect(res.statusCode, res.body).toBe(409);
      expect(codeOf(res)).toBe('VAT_MODE_REQUIRED');
      expect((await vendorRow()).vatStatus).toBe('PENDING');
    } finally {
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { vatMode: 'ADD_VAT_AT_CHECKOUT' } });
    }
  });
});

describe('2. approved: VAT added INTO every standard-rated price the customer sees', () => {
  it('a cart priced before the approval is refused at checkout with PRICE_CHANGED: the customer confirms the new full total', async () => {
    const before = await fillCart([{ itemId: soapId, quantity: 1 }]);
    await approve();
    const stale = await checkoutCall({ expectedTotal: before.totalAmount });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(codeOf(stale)).toBe('PRICE_CHANGED');
    await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  });

  it('standard items + their options: typed + 14%, the typed price kept beside it; zero-rated untouched', async () => {
    expect(await prices(soapId)).toEqual({ basePrice: 114, vatListedPrice: 100 });
    expect(await optionPrices(sizeOptionId)).toEqual({ additionalPrice: 11, vatListedAdditionalPrice: 10 });
    expect(await prices(riceId)).toEqual({ basePrice: 600, vatListedPrice: null });
    const view = await vendorCall('GET', '/vat');
    expect(view.json().data).toMatchObject({ status: 'APPROVED', mode: 'ADD_VAT_AT_CHECKOUT', effective: true, addsVatToPrices: true });
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: ownerUserId, title: 'Your VAT is approved' } });
    expect(notice.body).toContain('From now on, Swift adds VAT at 14% to the prices you type for standard-rated items, so customers see and pay prices that include VAT');
  });

  it('the store’s own menu shows what it typed (vatListedPrice) next to what customers pay, as numbers', async () => {
    const res = await vendorCall('GET', '/items');
    expect(res.statusCode, res.body).toBe(200);
    const soap = (res.json().data as Array<Record<string, unknown> & { optionGroups: Array<{ options: Array<Record<string, unknown>> }> }>).find((i) => i['id'] === soapId)!;
    expect(soap).toMatchObject({ basePrice: 114, vatListedPrice: 100 });
    expect(soap.optionGroups[0]!.options[0]).toMatchObject({ additionalPrice: 11, vatListedAdditionalPrice: 10 });
  });

  it('storefront, cart quote, checkout and receipt all carry the SAME full price; the order is for exactly the quote', async () => {
    const page = await storefront();
    expect(page.vat).toEqual({ pricesIncludeVat: true, ratePercent: 14 });
    expect(await shownPrice(soapId)).toBe(114);
    const quote = await fillCart([{ itemId: soapId, quantity: 2, options: { [sizeGroupId]: sizeOptionId } }, { itemId: riceId, quantity: 1 }]);
    // 2 x (114 + 11) + 600 = 850; VAT inside the standard goods: 250 x 14/114 = 30.70 -> 31.
    expect(quote.subtotalCustomer).toBe(850);
    expect(quote.vendors[0]!.vat).toMatchObject({ included: 31, standardGoods: 250, zeroRatedGoods: 600 });
    const res = await checkoutCall({ expectedTotal: quote.totalAmount });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const order = await app.prisma.order.findFirstOrThrow({ where: { customerId: customer.userId }, orderBy: { createdAt: 'desc' } });
    placedOrderId = order.id;
    expect(Number(order.totalAmount)).toBe(quote.totalAmount);
    expect(Number(order.subtotalCustomer)).toBe(850);
    expect(Number(order.taxAmount)).toBe(0); // never a second VAT on top of the total
    expect(Number(order.vatAmount)).toBe(31);
    expect(order).toMatchObject({ vatRateBps: 1400, vatSellerNumber: VAT_NUMBER, vatSellerName: 'Vat Add Trading' });
    await walkOrderStatus(app.prisma as never, order.id, 'DELIVERED', { paymentStatus: 'CAPTURED', deliveredAt: new Date() });
    const receipt = await call('GET', `/api/v1/customer/orders/${order.id}/receipt`, customer.token);
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.body).toContain('VAT included (14%)');
    expect(receipt.body).toContain(`VAT charged by Vat Add Trading · VAT reg. no. ${VAT_NUMBER}.`);
  });
});

describe('3. every price the store types afterwards gets VAT added; an older app never moves it', () => {
  it('the editor (updated apps send vatListedPrice): typed 200 -> customers pay 228', async () => {
    const res = await vendorCall('PUT', `/items/${soapId}`, { vatListedPrice: 200 });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
  });

  it('an older app sending the price customers pay back UNCHANGED (with another edit) changes no price', async () => {
    const res = await vendorCall('PUT', `/items/${soapId}`, { basePrice: 228, description: 'Bar soap' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
  });

  it('an older app sending a NEW basePrice is refused (409 VAT_PRICE_BEFORE_VAT): it cannot say whether VAT is in it', async () => {
    const res = await vendorCall('PUT', `/items/${soapId}`, { basePrice: 250 });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('VAT_PRICE_BEFORE_VAT');
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
  });

  it('the item becomes zero-rated: its typed price back; standard again: VAT added again', async () => {
    let res = await vendorCall('PUT', `/items/${soapId}`, { vatClass: 'ZERO_RATED' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prices(soapId)).toEqual({ basePrice: 200, vatListedPrice: null });
    expect(await optionPrices(sizeOptionId)).toEqual({ additionalPrice: 10, vatListedAdditionalPrice: null });
    res = await vendorCall('PUT', `/items/${soapId}`, { vatClass: 'STANDARD' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
    expect(await optionPrices(sizeOptionId)).toEqual({ additionalPrice: 11, vatListedAdditionalPrice: 10 });
  });

  it('a new item, a new option, an option edit: the typed price + 14%', async () => {
    const created = await vendorCall('POST', '/items', { categoryId, name: word('Brush'), basePrice: 50, optionGroups: [{ name: 'Pack', options: [{ name: 'Two', additionalPrice: 25 }] }] });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const brushId = created.json().data.id as string;
    expect(await prices(brushId)).toEqual({ basePrice: 57, vatListedPrice: 50 });
    const brush = await itemRow(brushId);
    expect(await optionPrices(brush.optionGroups[0]!.options[0]!.id)).toEqual({ additionalPrice: 29, vatListedAdditionalPrice: 25 });

    const added = await vendorCall('POST', `/option-groups/${brush.optionGroups[0]!.id}/options`, { name: 'Three', additionalPrice: 20 });
    expect(added.statusCode, added.body).toBeLessThan(300);
    const threeId = added.json().data.id as string;
    expect(await optionPrices(threeId)).toEqual({ additionalPrice: 23, vatListedAdditionalPrice: 20 });

    const edited = await vendorCall('PUT', `/options/${threeId}`, { vatListedAdditionalPrice: 30 });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(await optionPrices(threeId)).toEqual({ additionalPrice: 34, vatListedAdditionalPrice: 30 });
    const echo = await vendorCall('PUT', `/options/${threeId}`, { additionalPrice: 34, name: 'Three pack' });
    expect(echo.statusCode, echo.body).toBe(200);
    expect(await optionPrices(threeId)).toEqual({ additionalPrice: 34, vatListedAdditionalPrice: 30 });
    const moved = await vendorCall('PUT', `/options/${threeId}`, { additionalPrice: 40 });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(codeOf(moved)).toBe('VAT_PRICE_BEFORE_VAT');
  });

  it('a file import: the file’s price is the typed price', async () => {
    const res = await vendorCall('POST', '/items/import', { csv: `category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment\nShelf,${word('Sponge')},,40,SPONGE-${RUN},,,true,` });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const sponge = await app.prisma.item.findFirstOrThrow({ where: { vendorId, sku: `SPONGE-${RUN}` } });
    expect(await prices(sponge.id)).toEqual({ basePrice: 46, vatListedPrice: 40 }); // 45.60 -> 46
  });

  it('the till sync compares with the typed price (no false change) and a new till price gets VAT added', async () => {
    const tenantId = (await vendorRow()).tenantId;
    const same = 'sku,basePrice\n' + `SOAP-${RUN},200`;
    const sameRows = [{ sku: `SOAP-${RUN}`, basePrice: '200' }];
    const unchanged = await previewSync(app.prisma as never, { vendorId, csv: same, rows: sameRows, missingPolicy: 'LEAVE', canAddNew: false });
    expect(unchanged.changes.filter((c) => c.price)).toEqual([]);
    const csv = 'sku,basePrice\n' + `SOAP-${RUN},300`;
    const rows = [{ sku: `SOAP-${RUN}`, basePrice: '300' }];
    const preview = await previewSync(app.prisma as never, { vendorId, csv, rows, missingPolicy: 'LEAVE', canAddNew: false });
    expect(preview.changes.find((c) => c.itemId === soapId)?.price).toEqual({ from: 200, to: 300 });
    await confirmSync(app.prisma as never, {
      vendorId, tenantId, actorId: ownerUserId, uploadId: preview.uploadId, contentHash: preview.contentHash, planDigest: preview.planDigest,
      csv, rows, missingPolicy: 'LEAVE', canAddNew: false,
    });
    expect(await prices(soapId)).toEqual({ basePrice: 342, vatListedPrice: 300 });
    await vendorCall('PUT', `/items/${soapId}`, { vatListedPrice: 200 });
  });

  it('a menu copied to another branch takes the TYPED prices; that branch’s own VAT decides (none here)', async () => {
    const other = await app.prisma.vendor.create({ data: {
      ownerId: (await vendorRow()).ownerId, name: `Vat Add Branch ${RUN}`, slug: `vat-add-branch-${RUN.toLowerCase()}`, vendorType: 'SUPERMARKET',
      phone: testPhone(), addressLine1: '5 Vat St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
    } });
    vendorIds.push(other.id);
    const menu = await readLiveMenu(app.prisma as never, vendorId);
    await app.prisma.$transaction((tx) => writeMenuCopy(tx, { targetId: other.id, menu, banned: new Set(), photoMap: new Map() }));
    const copied = await app.prisma.item.findFirstOrThrow({ where: { vendorId: other.id, sku: `SOAP-${RUN}` }, include: { optionGroups: { include: { options: true } } } });
    expect(Number(copied.basePrice)).toBe(200);
    expect(copied.vatListedPrice).toBeNull();
    expect(Number(copied.optionGroups[0]!.options[0]!.additionalPrice)).toBe(10);
  });
});

describe('4. VAT stops being added: every price back to what the store typed, at once', () => {
  it('"my prices already include VAT" on the approved store: typed prices back, approval kept; "add VAT" again: added again', async () => {
    let res = await vendorCall('PUT', '/vat', { registered: true, mode: 'PRICES_INCLUDE_VAT' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'APPROVED', effective: true, addsVatToPrices: false });
    expect(await prices(soapId)).toEqual({ basePrice: 200, vatListedPrice: null });
    res = await vendorCall('PUT', '/vat', { registered: true, mode: 'ADD_VAT_AT_CHECKOUT' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
  });

  it('a person withdraws it: typed prices back; the placed order keeps its total and its VAT', async () => {
    const res = await adminCall(`/store-vat/${vendorId}/revoke`, { reason: 'The GRA cancelled the registration this month.' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prices(soapId)).toEqual({ basePrice: 200, vatListedPrice: null });
    expect(await optionPrices(sizeOptionId)).toEqual({ additionalPrice: 10, vatListedAdditionalPrice: null });
    expect(await app.prisma.item.count({ where: { vendorId, vatListedPrice: { not: null } } })).toBe(0);
    expect(await shownPrice(soapId)).toBe(200);
    const placed = await app.prisma.order.findUniqueOrThrow({ where: { id: placedOrderId } });
    expect(Number(placed.vatAmount)).toBe(31);
    expect(Number(placed.subtotalCustomer)).toBe(850);
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: ownerUserId, title: 'Your VAT was withdrawn' } });
    expect(notice.body).toContain('Swift no longer adds VAT to your prices: customers pay the prices you typed.');
  });

  it('approved again, then the store changes its VAT number: PENDING, typed prices back before anyone re-checks', async () => {
    const sent = await sendCertificate({});
    expect(sent.statusCode, sent.body).toBe(201);
    await approve();
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
    const res = await vendorCall('PUT', '/profile', { vatRegistrationNumber: '98765432' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await vendorRow()).vatStatus).toBe('PENDING');
    expect(await prices(soapId)).toEqual({ basePrice: 200, vatListedPrice: null });
  });

  it('approved again, then a NEW certificate is sent: PENDING, typed prices back until a person looks', async () => {
    await vendorCall('PUT', '/profile', { vatRegistrationNumber: VAT_NUMBER });
    await sendCertificate({ vatRegistrationNumber: VAT_NUMBER });
    await approve();
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
    const res = await sendCertificate({});
    expect(res.statusCode, res.body).toBe(201);
    expect((await vendorRow()).vatStatus).toBe('PENDING');
    expect(await prices(soapId)).toEqual({ basePrice: 200, vatListedPrice: null });
  });

  it('approved again, then the store says it is not VAT-registered: typed prices back', async () => {
    await approve();
    expect(await prices(soapId)).toEqual({ basePrice: 228, vatListedPrice: 200 });
    const res = await vendorCall('PUT', '/vat', { registered: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prices(soapId)).toEqual({ basePrice: 200, vatListedPrice: null });
    expect(await app.prisma.option.count({ where: { vatListedAdditionalPrice: { not: null }, optionGroup: { item: { vendorId } } } })).toBe(0);
  });

  it('reconcile is idempotent and writes nothing for a store that adds no VAT', async () => {
    const moved = await app.prisma.$transaction((tx) => reconcileVatPricing(tx, vendorId));
    expect(moved).toEqual({ added: 0, restored: 0 });
  });
});
