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
import { PickingService } from '../modules/order/picking.service';
import { approveStoreVat, type DocumentDecider } from '../modules/store-vat/store-vat-decisions';
import { VAT_CERTIFICATE_DOC_TYPE } from '../modules/store-vat/store-vat';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';
import { ownedVerificationFixture } from './helpers/verification-object';
import { testPhone } from './helpers/fixture-ids';
import { walkOrderStatus } from './helpers/order-status-walk';

// ---------------------------------------------------------------------------
// [STORE-VAT · owner O-5] A VAT-registered store's VAT, end to end on a real database.
//   - STORE_VAT is OFF unless exactly '1'; even ON, nothing a customer sees changes until a PERSON approves the
//     store's GRA VAT certificate (standing rule 4; VAT Act s.67(7): a false VAT number is an offence);
//   - the certificate is filed only through the store's own VAT route, never sent to a document processor, never
//     auto-approved, and never counts toward activation;
//   - the reviewer types the number, the registered name and the effective date from the certificate; a mismatch,
//     a future date, a recused reviewer or a machine-approved certificate is refused;
//   - VAT is INSIDE the price (s.90): carts, checkouts and totals are unchanged; the order freezes the VAT included
//     in its goods, and every change to the goods (a swap, a removed line) recomputes it;
//   - a withdrawn certificate, a changed number or the switch going off stops VAT for NEW orders at once; an order
//     already placed keeps what it froze.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const REASON = `Checked the GRA certificate against the store record ${RUN}`;
const VAT_NUMBER = '012345678';

let app: FastifyInstance;
let verification: VerificationService;
const userIds: string[] = [];
const vendorIds: string[] = [];
let ownerUserId = '';
let ownerToken = '';
let reviewerId = '';
let reviewerToken = '';
let customer: { userId: string; token: string; addressId: string };
let vendorId = '';
let categoryId = '';
let soapId = '';
let riceId = '';
let towelId = '';
let certificateDocId = '';
let vatOrderId = '';
let itemSeq = 0;
const word = (w: string) => `${w} ${(itemSeq += 1)}`;

class CountingKyc implements KycProvider {
  calls = 0;
  async verifyIdentity(): Promise<KycVerificationResult> { this.calls += 1; return { status: 'approved', referenceToken: `k_${nanoid(6)}`, confidence: 0.99 }; }
  async verifyDocument(): Promise<KycVerificationResult> { this.calls += 1; return { status: 'approved', referenceToken: `k_${nanoid(6)}`, confidence: 0.99 }; }
  async getStatus(): Promise<'approved'> { return 'approved'; }
}

async function session(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `vat-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
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
const storefront = async () => {
  const res = await call('GET', `/api/v1/customer/vendors/${vendorId}`, customer.token);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { vat: unknown; categories: Array<{ items: Array<{ id: string; vatClass?: string; basePrice: number }> }> };
};
const vendorRow = () => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
const codeOf = (res: { json: () => { error?: { code?: string }; code?: string } }) => res.json().error?.code ?? res.json().code;

async function fillCart(lines: Array<{ itemId: string; quantity: number }>) {
  await app.prisma.cart.deleteMany({ where: { customerId: customer.userId } });
  for (const line of lines) {
    const add = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId: line.itemId, quantity: line.quantity });
    expect(add.statusCode, add.body).toBeLessThan(300);
  }
  const address = await call('PUT', '/api/v1/customer/cart/address', customer.token, { addressId: customer.addressId });
  expect(address.statusCode, address.body).toBeLessThan(300);
  const cart = await call('GET', '/api/v1/customer/cart', customer.token);
  expect(cart.statusCode, cart.body).toBe(200);
  return cart.json().data as { totalAmount: number; subtotalCustomer: number; vendors: Array<{ vendorId: string; totalAmount: number; vat: unknown }> };
}

async function checkout() {
  const res = await call('POST', '/api/v1/customer/checkout', customer.token, { paymentMethod: 'CASH' }, { 'idempotency-key': `vat-${nanoid(10)}` });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return app.prisma.order.findFirstOrThrow({ where: { customerId: customer.userId }, orderBy: { createdAt: 'desc' }, include: { items: true } });
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
  verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new CountingKyc());

  const owner = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER',
    isPhoneVerified: true, countryCode: 'GY', selfieCapturedAt: new Date(),
  } });
  ownerUserId = owner.id; userIds.push(owner.id);
  ownerToken = await session(owner.id, 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({ data: {
    ownerId: vo.id, name: `Vat Corner ${RUN}`, slug: `vat-corner-${RUN.toLowerCase()}`, vendorType: 'SUPERMARKET',
    phone: testPhone(), addressLine1: '1 Vat St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
  } });
  vendorId = vendor.id; vendorIds.push(vendor.id);
  // A live store: its own checklist, approved by a person. Every document decision re-projects the owner's stores, so
  // a store missing its checklist would be closed by that projection whatever the VAT certificate did.
  const { checklist } = await verification.activationChecklist(owner.id, 'SUPERMARKET');
  expect(checklist).not.toContain(VAT_CERTIFICATE_DOC_TYPE);
  for (const docType of checklist) {
    await app.prisma.verificationDocument.create({ data: {
      userId: owner.id, role: 'VENDOR_OWNER', docType, fileUrl: `verification/${RUN}/${docType}.enc`,
      status: 'APPROVED', reviewedBy: 'seed', reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1',
    } as never });
  }
  expect((await verification.activationChecklist(owner.id, 'SUPERMARKET')).complete).toBe(true);
  categoryId =(await app.prisma.category.create({ data: { vendorId, name: 'Shelf', sortOrder: 0 } })).id;
  const item = (name: string, price: number, vatClass?: 'ZERO_RATED' | 'EXEMPT') =>
    app.prisma.item.create({ data: { vendorId, categoryId, name: word(name), basePrice: price, isAvailable: true, ...(vatClass ? { vatClass } : {}) } });
  soapId = (await item('Soap', 1000)).id;
  riceId = (await item('Rice', 600, 'ZERO_RATED')).id;
  towelId = (await item('Towel', 1000, 'ZERO_RATED')).id;

  const reviewer = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Reviewer', roles: ['SUPER_ADMIN', 'CUSTOMER'] as UserRole[], activeRole: 'SUPER_ADMIN',
    status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*', 'documents.review'] } }, // [VERIFY-DOCS V3] the explicit reviewer grant
  } });
  reviewerId = reviewer.id; userIds.push(reviewer.id);
  reviewerToken = await session(reviewer.id, 'SUPER_ADMIN');

  const cust = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Vat', lastName: 'Buyer', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER',
    isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
  } });
  userIds.push(cust.id);
  const addr = await app.prisma.address.create({ data: { userId: cust.id, label: 'Home', addressLine1: '2 Buyer St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } });
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

describe('1. the switch: OFF unless exactly "1"', () => {
  it('OFF: the store cannot say yes (409 STORE_VAT_OFF) and its VAT view says unavailable; saying "no" always works', async () => {
    process.env['STORE_VAT'] = '';
    try {
      const view = await vendorCall('GET', '/vat');
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json().data).toMatchObject({ available: false, status: 'NONE', effective: false, ratePercent: 14 });
      const yes = await vendorCall('PUT', '/vat', { registered: true, vatRegistrationNumber: VAT_NUMBER, mode: 'PRICES_INCLUDE_VAT' });
      expect(yes.statusCode, yes.body).toBe(409);
      expect(codeOf(yes)).toBe('STORE_VAT_OFF');
      const no = await vendorCall('PUT', '/vat', { registered: false });
      expect(no.statusCode, no.body).toBe(200);
      expect((await vendorRow()).vatStatus).toBe('NONE');
    } finally {
      process.env['STORE_VAT'] = '1';
    }
  });
});

describe('2. the store says it is VAT-registered: PENDING, nothing a customer sees changes', () => {
  it('"add VAT at checkout" is not offered in this release (409); a yes needs the number', async () => {
    const add = await vendorCall('PUT', '/vat', { registered: true, vatRegistrationNumber: VAT_NUMBER, mode: 'ADD_VAT_AT_CHECKOUT' });
    expect(add.statusCode, add.body).toBe(409);
    expect(codeOf(add)).toBe('VAT_MODE_NOT_AVAILABLE');
    const noNumber = await vendorCall('PUT', '/vat', { registered: true, mode: 'PRICES_INCLUDE_VAT' });
    expect(noNumber.statusCode, noNumber.body).toBe(400);
    expect(codeOf(noNumber)).toBe('VAT_NUMBER_REQUIRED');
    expect((await vendorRow()).vatStatus).toBe('NONE');
  });

  it('a certificate cannot be sent before the store says yes', async () => {
    const res = await vendorCall('POST', '/vat/certificate', { fileUrl: await ownedVerificationFixture(app.prisma, ownerUserId), consent: true, privacyNoticeVersion: 'v1' });
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res)).toBe('VAT_NOT_CLAIMED');
  });

  it('the business’s VAT is the OWNER’s to give: a store manager can neither read it, answer it nor send a certificate (403)', async () => {
    const manager = await app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Vat', lastName: 'Manager', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true,
    } });
    userIds.push(manager.id);
    await app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.id, role: 'MANAGER', invitedBy: ownerUserId } });
    const token = await session(manager.id, 'CUSTOMER');
    const asks = [
      ['GET', '/vat', undefined],
      ['PUT', '/vat', { registered: true, vatRegistrationNumber: VAT_NUMBER, mode: 'PRICES_INCLUDE_VAT' }],
      ['POST', '/vat/certificate', { fileUrl: await ownedVerificationFixture(app.prisma, ownerUserId), consent: true, privacyNoticeVersion: 'v1' }],
    ] as const;
    for (const [method, path, payload] of asks) {
      const res = await call(method, `/api/v1/vendor${path}`, token, payload);
      expect(res.statusCode, `${method} ${path} ${res.body}`).toBe(403);
    }
    expect((await vendorRow()).vatStatus).toBe('NONE');
  });

  it('yes + number + "prices include VAT" -> PENDING; the storefront still shows no VAT', async () => {
    const res = await vendorCall('PUT', '/vat', { registered: true, vatRegistrationNumber: VAT_NUMBER, mode: 'PRICES_INCLUDE_VAT' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ available: true, status: 'PENDING', mode: 'PRICES_INCLUDE_VAT', effective: false, approved: null });
    const page = await storefront();
    expect(page.vat).toBeNull();
    expect(page.categories.flatMap((c) => c.items).every((i) => !('vatClass' in i))).toBe(true);
  });
});

describe('3. the certificate: filed for a PERSON, never a machine', () => {
  it('the generic document door can never file it (INVALID_DOC_TYPE), and nothing is sent to a processor', async () => {
    const kyc = new CountingKyc();
    const svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
    await expect(svc.submitDocument(ownerUserId, 'SUPERMARKET', VAT_CERTIFICATE_DOC_TYPE, await ownedVerificationFixture(app.prisma, ownerUserId), 'v1'))
      .rejects.toMatchObject({ code: 'INVALID_DOC_TYPE' });
    expect(kyc.calls).toBe(0);
  });

  it('with the store-VAT intake, even an APPROVING processor is never asked: the certificate waits PENDING for a person', async () => {
    const kyc = new CountingKyc();
    const svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), kyc);
    const doc = await svc.submitDocument(ownerUserId, 'SUPERMARKET', VAT_CERTIFICATE_DOC_TYPE, await ownedVerificationFixture(app.prisma, ownerUserId), 'v1', 'VENDOR_OWNER', { storeVatCertificate: true });
    expect(kyc.calls).toBe(0);
    expect(doc.status).toBe('PENDING');
    expect(doc.reviewedBy).toBeNull();
    expect(doc.kycRef).toMatch(/^manual_/);
    expect(await app.prisma.reviewCase.count({ where: { submissionId: doc.id, closedAt: null } })).toBe(1);
  });

  it('the store-VAT route files it while STORE_VAT is on and links it to the store (still PENDING); refused while off', async () => {
    process.env['STORE_VAT'] = '';
    const off = await vendorCall('POST', '/vat/certificate', { fileUrl: await ownedVerificationFixture(app.prisma, ownerUserId), consent: true, privacyNoticeVersion: 'v1' });
    process.env['STORE_VAT'] = '1';
    expect(off.statusCode, off.body).toBe(409);
    expect(codeOf(off)).toBe('STORE_VAT_OFF');

    const res = await vendorCall('POST', '/vat/certificate', { fileUrl: await ownedVerificationFixture(app.prisma, ownerUserId), consent: true, privacyNoticeVersion: 'v1' });
    expect(res.statusCode, res.body).toBe(201);
    const row = await vendorRow();
    expect(row.vatStatus).toBe('PENDING');
    expect(row.vatCertificateDocId).toBeTruthy();
    certificateDocId = row.vatCertificateDocId!;
    const doc = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: certificateDocId } });
    expect(doc).toMatchObject({ docType: VAT_CERTIFICATE_DOC_TYPE, status: 'PENDING', userId: ownerUserId });
    expect(res.json().data.certificate).toMatchObject({ id: certificateDocId, status: 'PENDING' });
  });
});

describe('4. a PERSON decides', () => {
  const approveBody = (over: Record<string, unknown> = {}) => ({
    certificateDocId, vatNumber: VAT_NUMBER, registeredName: 'Vat Corner Trading', effectiveFrom: '2026-01-01', nameMatchesStore: true, ...over,
  });

  it('refused: the typed number differs from the store’s (409), a future effective date (400), the name not confirmed (400)', async () => {
    const mismatch = await adminCall(`/store-vat/${vendorId}/approve`, approveBody({ vatNumber: '999999999' }));
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    expect(codeOf(mismatch)).toBe('VAT_NUMBER_MISMATCH');
    const future = await adminCall(`/store-vat/${vendorId}/approve`, approveBody({ effectiveFrom: '2099-01-01' }));
    expect(future.statusCode, future.body).toBe(400);
    expect(codeOf(future)).toBe('VAT_EFFECTIVE_IN_FUTURE');
    const unconfirmed = await adminCall(`/store-vat/${vendorId}/approve`, approveBody({ nameMatchesStore: false }));
    expect(unconfirmed.statusCode).toBe(400);
    expect((await vendorRow()).vatStatus).toBe('PENDING');
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: certificateDocId } })).status).toBe('PENDING');
  });

  it('refused: the store owner can never approve their own VAT (recusal)', async () => {
    await expect(approveStoreVat(app.prisma, verification as unknown as DocumentDecider, vendorId, ownerUserId, {
      certificateDocId, typedVatNumber: VAT_NUMBER, registeredName: 'Vat Corner Trading', effectiveFrom: new Date('2026-01-01'), nameMatchesStore: true,
    }, async () => {})).rejects.toMatchObject({ code: 'REVIEWER_RECUSED' });
    expect((await vendorRow()).vatStatus).toBe('PENDING');
  });

  it('refused: a certificate only a MACHINE approved never backs a VAT approval', async () => {
    const machine = await app.prisma.verificationDocument.create({ data: {
      userId: ownerUserId, role: 'VENDOR_OWNER', docType: VAT_CERTIFICATE_DOC_TYPE, fileUrl: `test/${RUN}/machine`,
      status: 'APPROVED', state: 'COMMITTED', reviewedBy: 'kyc:auto', reviewedAt: new Date(),
    } as never });
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { vatCertificateDocId: machine.id } });
    try {
      const res = await adminCall(`/store-vat/${vendorId}/approve`, approveBody({ certificateDocId: machine.id }));
      expect(res.statusCode, res.body).toBe(409);
      expect(codeOf(res)).toBe('VAT_CERTIFICATE_NOT_STANDING');
      expect((await vendorRow()).vatStatus).toBe('PENDING');
    } finally {
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { vatCertificateDocId: certificateDocId } });
    }
  });

  it('approved: the certificate AND the store’s VAT in one decision, with the trail; the number, name and date are frozen', async () => {
    const res = await adminCall(`/store-vat/${vendorId}/approve`, approveBody());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'APPROVED', effective: true, approved: { number: VAT_NUMBER, registeredName: 'Vat Corner Trading' } });
    const row = await vendorRow();
    expect(row).toMatchObject({ vatStatus: 'APPROVED', vatApprovedNumber: VAT_NUMBER, vatApprovedName: 'Vat Corner Trading', vatReviewedBy: reviewerId });
    expect(row.vatEffectiveFrom?.toISOString().slice(0, 10)).toBe('2026-01-01');
    // The certificate is no store document: approving it neither opens nor closes the store.
    expect(row).toMatchObject({ status: 'ACTIVE', isVerified: true, acceptingOrders: true });
    const doc = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: certificateDocId } });
    expect(doc).toMatchObject({ status: 'APPROVED', reviewedBy: reviewerId });
    expect(await app.prisma.auditLog.count({ where: { action: 'APPROVE_STORE_VAT', entityId: vendorId, userId: reviewerId } })).toBe(1);
  });
});

describe('5. VAT inside the price: storefront, cart, checkout', () => {
  it('the storefront marks the store and each item’s class (the price itself unchanged)', async () => {
    const page = await storefront();
    expect(page.vat).toEqual({ pricesIncludeVat: true, ratePercent: 14 });
    const items = new Map(page.categories.flatMap((c) => c.items).map((i) => [i.id, i]));
    expect(items.get(soapId)).toMatchObject({ vatClass: 'STANDARD', basePrice: 1000 });
    expect(items.get(riceId)).toMatchObject({ vatClass: 'ZERO_RATED', basePrice: 600 });
  });

  it('the cart quote says the VAT INCLUDED per store; totals are the same as with VAT off', async () => {
    const withVat = await fillCart([{ itemId: soapId, quantity: 1 }, { itemId: riceId, quantity: 1 }]);
    expect(withVat.vendors[0]!.vat).toEqual({ included: 123, ratePercent: 14, standardGoods: 1000, zeroRatedGoods: 600, exemptGoods: 0 });
    process.env['STORE_VAT'] = '';
    try {
      const without = await fillCart([{ itemId: soapId, quantity: 1 }, { itemId: riceId, quantity: 1 }]);
      expect(without.vendors[0]!.vat).toBeNull();
      expect(without.totalAmount).toBe(withVat.totalAmount);
      expect(without.vendors[0]!.totalAmount).toBe(withVat.vendors[0]!.totalAmount);
      expect(withVat.subtotalCustomer).toBe(1600);
    } finally {
      process.env['STORE_VAT'] = '1';
    }
  });

  it('checkout freezes the seller, the rate, each line’s class and the VAT included; the total is unchanged', async () => {
    const quote = await fillCart([{ itemId: soapId, quantity: 1 }, { itemId: riceId, quantity: 1 }]);
    const order = await checkout();
    vatOrderId = order.id;
    expect(Number(order.totalAmount)).toBe(quote.totalAmount);
    expect(Number(order.taxAmount)).toBe(0);
    expect(order).toMatchObject({ vatRateBps: 1400, vatSellerNumber: VAT_NUMBER, vatSellerName: 'Vat Corner Trading' });
    expect(Number(order.vatAmount)).toBe(123);
    expect(Number(order.vatStandardGoods)).toBe(1000);
    expect(Number(order.vatZeroRatedGoods)).toBe(600);
    expect(Number(order.vatExemptGoods)).toBe(0);
    expect(Number(order.vatBase)).toBe(1000);
    const classes = new Map(order.items.map((i) => [i.itemId, i.vatClass]));
    expect(classes.get(soapId)).toBe('STANDARD');
    expect(classes.get(riceId)).toBe('ZERO_RATED');
  });
});

describe('6. the goods change, the VAT follows (one recompute)', () => {
  it('an approved swap takes the SUBSTITUTE’s class; a removed line carries no VAT', async () => {
    await walkOrderStatus(app.prisma as never, vatOrderId, 'PREPARING', { holdExpiresAt: null });
    const picking = new PickingService(app.prisma, app.io);
    const soapLine = await app.prisma.orderItem.findFirstOrThrow({ where: { orderId: vatOrderId, itemId: soapId } });
    await picking.proposeSubstitution(vatOrderId, soapLine.id, towelId, ownerUserId);
    await picking.decideSubstitution(vatOrderId, soapLine.id, customer.userId, true);
    let order = await app.prisma.order.findUniqueOrThrow({ where: { id: vatOrderId }, include: { items: true } });
    expect(order.items.find((i) => i.id === soapLine.id)?.vatClass).toBe('ZERO_RATED');
    expect(Number(order.vatAmount)).toBe(0);
    expect(Number(order.vatStandardGoods)).toBe(0);
    expect(Number(order.vatZeroRatedGoods)).toBe(1600);

    // The rice line comes off: the zero-rated goods drop by its 600; the total drops by the same.
    const before = Number(order.totalAmount);
    const riceLine = order.items.find((i) => i.itemId === riceId)!;
    await picking.refundLine(vatOrderId, riceLine.id, ownerUserId);
    order = await app.prisma.order.findUniqueOrThrow({ where: { id: vatOrderId }, include: { items: true } });
    expect(Number(order.totalAmount)).toBe(before - 600);
    expect(Number(order.vatZeroRatedGoods)).toBe(1000);
    expect(Number(order.vatAmount)).toBe(0);
  });

  it('a non-VAT order is never given VAT by a recompute', async () => {
    process.env['STORE_VAT'] = '';
    try {
      await fillCart([{ itemId: soapId, quantity: 2 }]);
      const order = await checkout();
      expect(order.vatRateBps).toBeNull();
      expect(order.vatAmount).toBeNull();
      expect(order.items.every((i) => i.vatClass === null)).toBe(true);
      await walkOrderStatus(app.prisma as never, order.id, 'PREPARING', { holdExpiresAt: null });
      await new PickingService(app.prisma, app.io).refundLine(order.id, order.items[0]!.id, ownerUserId);
      expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).vatAmount).toBeNull();
    } finally {
      process.env['STORE_VAT'] = '1';
    }
  });
});

describe('7. the receipt of the VAT order', () => {
  it('shows the VAT included and the store as the one charging it; never called a tax invoice', async () => {
    await walkOrderStatus(app.prisma as never, vatOrderId, 'DELIVERED', { paymentStatus: 'CAPTURED', deliveredAt: new Date() });
    const res = await call('GET', `/api/v1/customer/orders/${vatOrderId}/receipt`, customer.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('VAT included (14%)');
    expect(res.body).toContain(`VAT charged by Vat Corner Trading · VAT reg. no. ${VAT_NUMBER}.`);
    expect(res.body).toContain('(zero-rated)');
    expect(res.body).toMatch(/<h1>Receipt/);
    expect(res.body.toLowerCase().split('tax invoice').length - 1).toBe(1);
  });
});

describe('8. items: old apps never change a class; new apps can', () => {
  it('an item edit without vatClass keeps it; a create without it is STANDARD; a class can be set; nonsense is refused', async () => {
    const edit = await vendorCall('PUT', `/items/${riceId}`, { name: word('Rice') });
    expect(edit.statusCode, edit.body).toBe(200);
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: riceId } })).vatClass).toBe('ZERO_RATED');
    const created = await vendorCall('POST', '/items', { categoryId, name: word('Bread'), basePrice: 300 });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const breadId = created.json().data.id as string;
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: breadId } })).vatClass).toBe('STANDARD');
    const exempt = await vendorCall('PUT', `/items/${breadId}`, { vatClass: 'EXEMPT' });
    expect(exempt.statusCode, exempt.body).toBe(200);
    expect((await app.prisma.item.findUniqueOrThrow({ where: { id: breadId } })).vatClass).toBe('EXEMPT');
    const bad = await vendorCall('PUT', `/items/${breadId}`, { vatClass: 'LUXURY' });
    expect(bad.statusCode).toBe(400);
  });
});

describe('9. VAT stops for NEW orders at once; placed orders keep what they froze', () => {
  it('STORE_VAT off: no VAT on the storefront or a new order', async () => {
    process.env['STORE_VAT'] = '';
    try {
      expect((await storefront()).vat).toBeNull();
      await fillCart([{ itemId: soapId, quantity: 1 }]);
      expect((await checkout()).vatRateBps).toBeNull();
    } finally {
      process.env['STORE_VAT'] = '1';
    }
  });

  it('a changed VAT number on the profile: back to PENDING, approval cleared, no VAT', async () => {
    const res = await vendorCall('PUT', '/profile', { vatRegistrationNumber: '87654321' });
    expect(res.statusCode, res.body).toBe(200);
    const row = await vendorRow();
    expect(row).toMatchObject({ vatStatus: 'PENDING', vatApprovedNumber: null, vatApprovedName: null, vatReviewedBy: null });
    expect((await storefront()).vat).toBeNull();
  });

  it('a withdrawn certificate withdraws the store’s VAT in the same transaction; the placed order keeps its VAT', async () => {
    // Back to the approved number and an approval resting on the certificate (the reviewer re-checked it).
    await app.prisma.vendor.update({ where: { id: vendorId }, data: {
      vatRegistrationNumber: VAT_NUMBER, vatStatus: 'APPROVED', vatApprovedNumber: VAT_NUMBER, vatApprovedName: 'Vat Corner Trading',
      vatEffectiveFrom: new Date('2026-01-01T00:00:00Z'), vatReviewedBy: reviewerId, vatReviewedAt: new Date(),
    } });
    expect((await storefront()).vat).not.toBeNull();
    const placed = await app.prisma.order.findUniqueOrThrow({ where: { id: vatOrderId } });
    await verification.revokeDocument(certificateDocId, reviewerId, 'GRA cancelled the registration');
    const row = await vendorRow();
    expect(row.vatStatus).toBe('REVOKED');
    expect(row.vatReviewNote).toContain('Certificate withdrawn');
    expect((await storefront()).vat).toBeNull();
    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: vatOrderId } });
    expect(after.vatRateBps).toBe(placed.vatRateBps);
    expect(after.vatSellerNumber).toBe(VAT_NUMBER);
    expect(String(after.vatAmount)).toBe(String(placed.vatAmount));
  });

  it('a reviewer rejects a new claim with a reason the store reads; "no" clears everything', async () => {
    const yes = await vendorCall('PUT', '/vat', { registered: true, vatRegistrationNumber: VAT_NUMBER, mode: 'PRICES_INCLUDE_VAT' });
    expect(yes.json().data.status).toBe('PENDING');
    const sent = await vendorCall('POST', '/vat/certificate', { fileUrl: await ownedVerificationFixture(app.prisma, ownerUserId), consent: true, privacyNoticeVersion: 'v1' });
    expect(sent.statusCode, sent.body).toBe(201);
    const docId = (await vendorRow()).vatCertificateDocId!;
    const rejected = await adminCall(`/store-vat/${vendorId}/reject`, { reason: 'The certificate photo is unreadable' });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().data).toMatchObject({ status: 'REJECTED', reviewNote: 'The certificate photo is unreadable' });
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: docId } })).status).toBe('REJECTED');
    expect(await app.prisma.auditLog.count({ where: { action: 'REJECT_STORE_VAT', entityId: vendorId } })).toBe(1);
    const no = await vendorCall('PUT', '/vat', { registered: false });
    expect(no.json().data).toMatchObject({ status: 'NONE', mode: null, vatRegistrationNumber: null, certificate: null });
  });
});
