/**
 * [R3 · CAA s.70 · legal research D10 + E5 · owner 15 Oct 2026] The storefront seller block.
 *
 * Every store page (the app's store screen through GET /customer/vendors/:id, the website's
 * /store/[slug] through GET /public/storefronts/:slug) carries ONE seller block: the store's legal
 * name, business address and phone, how payment works (cash at handover; the store's own MMG only
 * when it has a working link), the store's own refund rule, and the statutory-rights sentence.
 * Only what is on file is shown — a missing fact is null, which the page renders as "Ask the store";
 * nothing is invented. The operator behind the platform is the ONE OPERATOR constant, never
 * configuration. The refund rule is the store owner's own words, checked on write.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { customerRoutes } from '../modules/user/customer.routes';
import { publicRoutes } from '../modules/public/public.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { resetPublicDisclosureCacheForTests } from '../modules/verification/storefront-disclosure';
import { documentRecordDdl } from '../modules/verification/document-record';
import { docStateMachineDdl } from '../modules/verification/doc-state';
import { installDdl } from './helpers/install-ddl';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { rlsDdlFor, tenantLineageDdl } from '../lib/tenant-rls';

grantSuiteCapability('ddl');

/** Legal research E5, verbatim (owner 15 Oct 2026). */
const STATUTORY = "This does not affect your rights under Guyana's Consumer Affairs Act 2011 to return goods or get a refund from the business.";
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const LINK = 'https://pay.example.com/pay/seller-block';

let app: FastifyInstance;
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'storefront-seller-block-test');

async function store(n: number, over: { publicPhone?: string | null; status?: 'ACTIVE' | 'PENDING_APPROVAL' } = {}) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59267${NUM}${n}`, firstName: 'Asha', lastName: `Ramdin${n}`, activeRole: 'VENDOR_OWNER', roles: ['VENDOR_OWNER', 'CUSTOMER'], countryCode: 'GY', isPhoneVerified: true,
    avatar: `avatars/${RUN}/${n}.jpg`, selfieCapturedAt: new Date(),
  } }));
  users.push(u.id);
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: u.id, vendors: { create: {
    name: `Asha's Bakery ${RUN}${n}`, slug: `ashas-bakery-${RUN.toLowerCase()}-${n}`, vendorType: 'RESTAURANT', phone: `+59267${NUM}${n}`,
    addressLine1: `${n} Robb Street`, addressLine2: 'Lacytown', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
    status: over.status ?? 'ACTIVE', isVerified: (over.status ?? 'ACTIVE') === 'ACTIVE',
    publicPhone: over.publicPhone === undefined ? '+5926001300' : over.publicPhone,
  } } }, include: { vendors: true } }));
  const vendor = owner.vendors[0]!;
  return { userId: u.id, vendorId: vendor.id, slug: vendor.slug };
}
const approved = (userId: string, docType: string) => system(() => app.prisma.verificationDocument.create({ data: {
  userId, role: 'VENDOR_OWNER', docType, fileUrl: `/uploads/verification/${RUN}/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'seller-block-test', reviewedAt: new Date(), expiresAt: new Date(Date.now() + 200 * DAY),
} }));
const setStore = (id: string, data: Record<string, unknown>) => system(() => app.prisma.vendor.update({ where: { id }, data }));
const appView = async (vendorId: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors/${vendorId}` });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};
const webView = async (slug: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/public/storefronts/${slug}` });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};
/** A signed-in session for the store's owner (or a staff member of it, who signs in as a customer). */
async function tokenFor(userId: string, role: 'VENDOR_OWNER' | 'CUSTOMER' = 'VENDOR_OWNER') {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    authMethod: 'OTP', userId, token, refreshToken: nanoid(48), deviceId: 'seller-block-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } }));
  return token;
}
const saveRefundRule = (token: string, vendorId: string, refundRule: unknown) => app.inject({
  method: 'PUT', url: '/api/v1/vendor/profile', payload: { refundRule } as Record<string, unknown>,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-vendor-id': vendorId },
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(publicRoutes, { prefix: '/api/v1/public' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  const tables = ['subject', 'subject_link', 'person_profile', 'business_profile', 'vehicle_profile', 'document_record'];
  await installDdl(app.prisma, [...tables.flatMap((t) => rlsDdlFor(t)), ...tenantLineageDdl().filter((s) => tables.some((t) => s.includes(`${t}_tenant_matches`))), ...docStateMachineDdl(), ...documentRecordDdl()]);
  await system(() => seedDocRegistry(app.prisma));
});

afterEach(() => { vi.unstubAllEnvs(); resetPublicDisclosureCacheForTests(); });

afterAll(async () => {
  await system(async () => {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: owners.map((o) => o.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[R3] every store page carries the seller block', () => {
  it('legal name, address, phone, payment, the refund rule and the statutory sentence — the same block in the app and on the website', async () => {
    const { userId, vendorId, slug } = await store(1);
    await approved(userId, 'owner_national_id');
    await setStore(vendorId, { refundRule: 'Bring it back within 3 days with your receipt for a refund.' });
    const expected = {
      legalName: `Asha Ramdin1 trading as Asha's Bakery ${RUN}1`,
      address: '1 Robb Street, Lacytown',
      phone: '+5926001300',
      payment: { cash: true, storeMmg: false },
      refundRule: 'Bring it back within 3 days with your receipt for a refund.',
      statutoryRights: STATUTORY,
    };
    expect((await appView(vendorId)).seller).toEqual(expected);
    expect((await webView(slug)).seller).toEqual(expected);
  });

  it('only what is on file: a fact Swift does not hold is null (the page says "Ask the store"), never invented', async () => {
    const { vendorId, slug } = await store(2, { publicPhone: null });
    const bare = { legalName: null, address: '2 Robb Street, Lacytown', phone: null, payment: { cash: true, storeMmg: false }, refundRule: null, statutoryRights: STATUTORY };
    expect((await appView(vendorId)).seller).toEqual(bare);
    expect((await webView(slug)).seller).toEqual(bare);
  });

  it('[PAYMENT-SIMPLIFY] switch off (default): MMG is named for a store with a valid MMG NUMBER, never for a pay link alone', async () => {
    vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
    vi.stubEnv('STORE_MMG_PAY_LINK', '');
    const { vendorId, slug } = await store(3001); // own index: main's row-248 receipt test uses 9
    await setStore(vendorId, { mmgPayUrl: LINK });
    expect((await appView(vendorId)).seller.payment).toEqual({ cash: true, storeMmg: false });
    await setStore(vendorId, { mmgNumber: '+5926001234' });
    expect((await appView(vendorId)).seller.payment).toEqual({ cash: true, storeMmg: true });
    const web = await webView(slug);
    expect(web.seller.payment).toEqual({ cash: true, storeMmg: true });
    expect(JSON.stringify(web)).not.toContain('6001234'); // the number is never on the storefront
    await setStore(vendorId, { mmgNumber: '+5922251234' }); // a landline row: re-checked on read
    expect((await appView(vendorId)).seller.payment).toEqual({ cash: true, storeMmg: false });
  });

  it('MMG is named only while the store has a working MMG link of its own (the dormant link, STORE_MMG_PAY_LINK=1)', async () => {
    vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
    vi.stubEnv('STORE_MMG_PAY_LINK', '1');
    const { vendorId, slug } = await store(3);
    await setStore(vendorId, { mmgPayUrl: LINK });
    expect((await appView(vendorId)).seller.payment).toEqual({ cash: true, storeMmg: true });
    expect((await webView(slug)).seller.payment).toEqual({ cash: true, storeMmg: true });
    // A stored link that no longer passes the checkout's own check is not offered at checkout, so it is not named here.
    await setStore(vendorId, { mmgPayUrl: 'http://pay.example.com/pay/seller-block' });
    expect((await appView(vendorId)).seller.payment).toEqual({ cash: true, storeMmg: false });
  });

  it('a store Swift does not show (pending approval) has no seller block, and the raw MMG link and refund column never ride the website payload', async () => {
    const pending = await store(4, { status: 'PENDING_APPROVAL' });
    expect((await appView(pending.vendorId)).seller).toBeNull();
    vi.stubEnv('MMG_PAY_URL_ALLOWED_HOSTS', 'pay.example.com');
    const live = await store(5);
    await setStore(live.vendorId, { mmgPayUrl: LINK, refundRule: 'Exchanges only, within 7 days.' });
    const web = await webView(live.slug);
    expect(JSON.stringify(web)).not.toContain(LINK);
    expect(web).not.toHaveProperty('mmgPayUrl');
    expect(web).not.toHaveProperty('refundRule');
    expect(web.seller.refundRule).toBe('Exchanges only, within 7 days.');
  });

  it('the operator behind the platform is the ONE OPERATOR constant, whatever the configuration says', async () => {
    vi.stubEnv('PLATFORM_LEGAL_NAME', 'Not The Operator Ltd');
    vi.stubEnv('PLATFORM_REGISTERED_ADDRESS', '9 Wrong Street');
    vi.stubEnv('SUPPORT_EMAIL', 'wrong@example.invalid');
    const { vendorId } = await store(6);
    const operator = { legalName: 'Westbridge Inc.', registeredAddress: 'Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana', supportEmail: 'support@swiftgy.com' };
    expect((await appView(vendorId)).disclosure.operator).toEqual(operator);
    vi.stubEnv('PLATFORM_LEGAL_NAME', '');
    vi.stubEnv('SUPPORT_EMAIL', '');
    resetPublicDisclosureCacheForTests();
    const block = (await appView(vendorId)).disclosure;
    expect(block.operator).toEqual(operator);
    expect(block.missing).not.toContain('operator');
  });
});

describe('[R3] the refund rule is the store owner\'s own words, checked on write', () => {
  it('the owner saves it, the storefront shows it; an empty save takes it down', async () => {
    const { userId, vendorId } = await store(7);
    const token = await tokenFor(userId);
    const saved = await saveRefundRule(token, vendorId, '  Returns within 7 days   with the receipt.  ');
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.refundRule).toBe('Returns within 7 days with the receipt.');
    expect((await appView(vendorId)).seller.refundRule).toBe('Returns within 7 days with the receipt.');
    const cleared = await saveRefundRule(token, vendorId, '');
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.refundRule).toBeNull();
    expect((await appView(vendorId)).seller.refundRule).toBeNull();
  });

  // Each case has its own fixed store index (REFUSAL_BASE + its row), clear of every other
  // store index in this file; storefront-seller-block-indexes.test.ts keeps them unique.
  const REFUSAL_BASE = 4001;
  const REFUSALS = [
    ['a link', 'Refunds: see https://example.com/refunds', 'REFUND_RULE_INVALID'],
    ['a web address without a scheme', 'Read www.example.com first', 'REFUND_RULE_INVALID'],
    ['more than 300 characters', `Refunds ${'x'.repeat(300)}`, 'REFUND_RULE_INVALID'],
    ['goods Swift never carries', 'No refunds on rum or cigarettes once opened.', 'REFUND_RULE_INVALID'],
  ] as const;
  it.each(REFUSALS.map(([what, text, code], row) => [what, text, code, REFUSAL_BASE + row] as const))('refuses %s, and keeps the rule on file as it was', async (_what, text, code, n) => {
    const { userId, vendorId } = await store(n);
    await setStore(vendorId, { refundRule: 'Exchanges only.' });
    const res = await saveRefundRule(await tokenFor(userId), vendorId, text);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { refundRule: true } }))).refundRule).toBe('Exchanges only.');
  });

  it('only the owner sets it: a manager is refused and nothing changes', async () => {
    const { vendorId } = await store(2001);
    const manager = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
      phone: `+59268${NUM}9`, firstName: 'Mgr', lastName: 'Seller', activeRole: 'CUSTOMER', roles: ['CUSTOMER'], countryCode: 'GY', isPhoneVerified: true,
    } }));
    users.push(manager.id);
    await system(() => app.prisma.vendorStaff.create({ data: { vendorId, userId: manager.id, role: 'MANAGER', invitedBy: 'seller-block-test' } }));
    const res = await saveRefundRule(await tokenFor(manager.id, 'CUSTOMER'), vendorId, 'Anything goes.');
    expect(res.statusCode).toBe(403);
    expect((await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { refundRule: true } }))).refundRule).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [Triage row 248 · R3 · CAA s.70] The order receipt names who sold, from the SAME seller block the store page shows:
// the legal name, address and published phone on file. With nothing on file it names the store by its trading name
// and address (never a guess). Synthetic store, customer and order.
// ---------------------------------------------------------------------------
describe('[row 248] the order receipt says who sold', () => {
  const orderIds: string[] = [];
  afterAll(async () => {
    await system(() => app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }));
  });

  async function deliveredOrderFrom(vendorId: string, n: number) {
    const customer = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
      phone: `+59269${NUM}${n}`, firstName: 'Rita', lastName: `Receipt${n}`, activeRole: 'CUSTOMER', roles: ['CUSTOMER'], countryCode: 'GY',
      isPhoneVerified: true, customer: { create: {} },
    } }));
    users.push(customer.id);
    const order = await system(() => app.prisma.order.create({ data: {
      orderNumber: `SOLD-${RUN}-${n}`, orderType: 'FOOD_DELIVERY' as never, customerId: customer.id, vendorId,
      status: 'DELIVERED' as never, fulfillment: 'DELIVERY' as never,
      deliveryAddress: '5 Receipt Row', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 2500, subtotalMarkup: 0, subtotalCustomer: 2500, deliveryFee: 600, tipAmount: 0, discount: 0, totalAmount: 3100,
      paymentMethod: 'CASH' as never,
      items: { create: [{ itemId: 'x1', name: 'Pepperpot', quantity: 1, basePrice: 2500, markedUpPrice: 2500, markupAmount: 0, totalBase: 2500, totalMarkup: 0, totalCustomer: 2500 }] },
    } }));
    orderIds.push(order.id);
    const res = await app.inject({
      method: 'GET', url: `/api/v1/customer/orders/${order.id}/receipt`,
      headers: { authorization: `Bearer ${await tokenFor(customer.id, 'CUSTOMER')}` },
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  it('names the seller’s legal name, address and published phone, as on the store page', async () => {
    const { userId, vendorId } = await store(9);
    await approved(userId, 'owner_national_id');
    const html = await deliveredOrderFrom(vendorId, 9);
    expect(html).toContain(`Sold by Asha Ramdin9 trading as Asha's Bakery ${RUN}9 — 9 Robb Street, Lacytown · +5926001300`);
  });

  it('with no legal name on file it names the store by its trading name and address, never a guess', async () => {
    const { vendorId } = await store(2002, { publicPhone: null });
    const html = await deliveredOrderFrom(vendorId, 2002);
    expect(html).toMatch(new RegExp(`Sold by Asha's Bakery ${RUN}2002 — 2002 Robb Street, (Lacytown|Georgetown)`));
    expect(html).not.toContain('trading as');
  });
});
