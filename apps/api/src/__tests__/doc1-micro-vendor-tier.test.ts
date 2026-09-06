/**
 * [DOC-1 §3.6 · FD-DOC-1 · P3-2 · E2E-DOC-1] The micro-vendor tier: capped, not bypassed.
 *
 * Contract-first (Fable): the tier, its caps, the checkout refusal, the promoted-placement
 * refusal and the automatic promotion are built and proven here. The parts queued for the
 * Opus build — the signed self-declaration route that PUTS a vendor on the tier, the
 * MICRO_VENDOR requirement set, and the 60 % nudge — are pinned as named failing tests so
 * the build lands against a test that already exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { seedDocRegistry } from '../modules/verification/doc-registry';
import { DECLARATION_CONSENT_TYPE } from '../modules/vendor/unregistered-declaration';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import {
  VENDOR_TIER_CAPS_DEFAULTS, assertPromotable, assertWithinTierCaps, judgeTierCap, promoteIfRegistered, tierUsage, vendorTierCapsFor,
} from '../modules/vendor/vendor-tier';
import { CountryConfigService } from '../modules/country/country-config.service';
import { EXTRA_DOC_TYPES, BUCKET_OF, DECLARATION_DOC_TYPE, REGISTRATION_DOC_TYPES } from '../modules/verification/doc-registry';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-micro-vendor-tier-test');
let app: FastifyInstance;
let customerId = '', ownerUserId = '', vendorId = '', itemId = '', customerToken = '';
const users: string[] = [];
const extraVendorIds: string[] = [];
let mkUser: (n: number, roles: string[], active: string, extra?: Record<string, unknown>) => Promise<{ id: string }>;
const orderIds: string[] = [];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  const mk = (n: number, roles: string[], active: string, extra: Record<string, unknown> = {}) => runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+5926${NUM}${String(n).padStart(2, '0')}`, firstName: 'Micro', lastName: `Vendor${n}`, roles: roles as never, activeRole: active as never, countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, trustLevel: 'L2', ...extra,
  } as never }));
  mkUser = mk;
  const c = await mk(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} }, selfieCapturedAt: new Date() }); customerId = c.id; users.push(c.id);
  customerToken = app.jwt.sign({ userId: customerId, role: 'CUSTOMER', jti: nanoid(8) });
  await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: customerId, token: customerToken, refreshToken: nanoid(24), deviceId: `mv-${NUM}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } }));
  const o = await mk(2, ['VENDOR_OWNER'], 'VENDOR_OWNER'); ownerUserId = o.id; users.push(o.id);
  const owner = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: ownerUserId, vendors: { create: {
    name: `Snackette ${RUN}`, slug: `snackette-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+5926${NUM}99`, addressLine1: '1 Stall Row', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'ACTIVE',
    tier: 'UNREGISTERED', tierNote: 'fixture: self-declared unregistered trader', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
  } } }, include: { vendors: true } }));
  vendorId = owner.vendors[0]!.id;
  const category = await system(() => app.prisma.category.create({ data: { vendorId, name: `Menu ${RUN}`, sortOrder: 0 } }));
  itemId = (await system(() => app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: `Plate ${RUN}`, basePrice: 1000 } as never }))).id;
});
afterAll(async () => {
  await system(async () => {
    await app.prisma.cart.deleteMany({ where: { customerId } });
    await app.prisma.orderItem.deleteMany({ where: { order: { customerId } } });
    await app.prisma.order.deleteMany({ where: { OR: [{ id: { in: orderIds } }, { customerId }] } });
    await app.prisma.documentRecord.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: users } } });
    // consent_records is append-only (DCR-1 NR-1): the signature rows stay, keyed to fixture ids
    await app.prisma.vendor.deleteMany({ where: { id: { in: extraVendorIds } } });
    // audit rows are hash-chained and append-only (P20-1): the promotion row stays, as it should
    await app.prisma.item.deleteMany({ where: { vendorId } });
    await app.prisma.category.deleteMany({ where: { vendorId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

async function placedOrder(gross: number, at: Date, status: 'PENDING' | 'DELIVERED' | 'CANCELLED' = 'DELIVERED') {
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `MV${NUM}${nanoid(4).replace(/[^a-zA-Z0-9]/g, '0').toUpperCase()}`, customerId, vendorId, status, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    paymentMethod: 'CASH', paymentStatus: 'PENDING', subtotalBase: gross, subtotalMarkup: 0, subtotalCustomer: gross, deliveryFee: 500, tipAmount: 0, totalAmount: gross + 500,
    deliveryAddress: '1 Test St', deliveryLat: 6.8, deliveryLng: -58.16, placedAt: at,
  } as never }));
  orderIds.push(o.id);
  return o;
}
const vendor = () => system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { id: true, name: true, tier: true, tierChangedAt: true } }));

describe('[DOC-1 P3-2] the micro-vendor tier is capped, not bypassed', () => {
  it('the caps carry the FD-DOC-1 defaults and merge over CountryConfig; a registered vendor is never judged', async () => {
    const caps = await system(() => vendorTierCapsFor(new CountryConfigService(app.prisma), 'GY'));
    expect(caps).toEqual(VENDOR_TIER_CAPS_DEFAULTS);
    expect(caps).toMatchObject({ ordersPerDay: 30, grossPerWeek: 150_000, nudgeAtFraction: 0.6 });
    const registered = { id: vendorId, name: 'x', tier: 'REGISTERED' as const };
    expect(await system(() => assertWithinTierCaps(app.prisma, registered, caps, 10_000_000, new Date()))).toBeNull();
  });

  it('the pure judgement: the 31st order of the day and the gross that crosses the week are refused; the nudge fires at 60 %', () => {
    const caps = VENDOR_TIER_CAPS_DEFAULTS;
    const base = { dayStart: new Date(), weekStart: new Date() };
    expect(judgeTierCap({ ...base, ordersToday: 29, grossThisWeek: 0 }, caps, 1000)).toMatchObject({ allowed: true, nudge: true });
    expect(judgeTierCap({ ...base, ordersToday: 30, grossThisWeek: 0 }, caps, 1000)).toMatchObject({ allowed: false, cap: 'ORDERS_PER_DAY' });
    expect(judgeTierCap({ ...base, ordersToday: 0, grossThisWeek: 149_000 }, caps, 1500)).toMatchObject({ allowed: false, cap: 'GROSS_PER_WEEK' });
    expect(judgeTierCap({ ...base, ordersToday: 0, grossThisWeek: 89_000 }, caps, 1000)).toMatchObject({ allowed: true, nudge: true });
    expect(judgeTierCap({ ...base, ordersToday: 5, grossThisWeek: 10_000 }, caps, 1000)).toMatchObject({ allowed: true, nudge: false });
  });

  it('usage is measured from real orders: today and the rolling week, cancelled orders excluded, older orders outside', async () => {
    const now = new Date();
    await placedOrder(20_000, new Date(now.getTime() - 2 * 3_600_000));
    await placedOrder(30_000, new Date(now.getTime() - 3 * 86_400_000));
    await placedOrder(999_999, new Date(now.getTime() - 2 * 3_600_000), 'CANCELLED');
    await placedOrder(40_000, new Date(now.getTime() - 9 * 86_400_000));
    const usage = await system(() => tierUsage(app.prisma, vendorId, now));
    expect(usage.ordersToday).toBe(now.getUTCHours() >= 2 ? 1 : 0);
    expect(usage.grossThisWeek).toBe(50_000);
    const v = await vendor();
    const verdict = await system(() => assertWithinTierCaps(app.prisma, v, VENDOR_TIER_CAPS_DEFAULTS, 1000, now));
    expect(verdict?.allowed).toBe(true);
    await expect(system(() => assertWithinTierCaps(app.prisma, v, VENDOR_TIER_CAPS_DEFAULTS, 100_001, now))).rejects.toMatchObject({ code: 'VENDOR_TIER_CAP' });
  });

  it('the checkout path itself refuses the order that would cross the day cap for an unregistered store, and accepts the same cart once the store is registered', async () => {
    const now = new Date();
    const today = await system(() => tierUsage(app.prisma, vendorId, now));
    for (let i = today.ordersToday; i < VENDOR_TIER_CAPS_DEFAULTS.ordersPerDay; i += 1) await placedOrder(1000, new Date(now.getTime() - 60_000));
    const inject = (method: 'POST', url: string, payload: unknown) => app.inject({ method, url, payload: payload as Record<string, unknown>, headers: { authorization: `Bearer ${customerToken}`, 'content-type': 'application/json' } });
    const added = await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 });
    expect([200, 201]).toContain(added.statusCode);
    const refused = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('VENDOR_TIER_CAP');
    expect(refused.json().error.message).toContain('unregistered seller');
    // The same cart at the registered tier goes through.
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { tier: 'REGISTERED' } }));
    const accepted = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } });
    expect(accepted.statusCode).toBe(200);
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { tier: 'UNREGISTERED' } }));
  });

  it('no promoted placement at the unregistered tier', async () => {
    expect(() => assertPromotable({ name: 'Snackette', tier: 'UNREGISTERED' })).toThrow(/unregistered seller/);
    expect(() => assertPromotable({ name: 'Snackette', tier: 'REGISTERED' })).not.toThrow();
  });

  it('a VALID business registration record promotes the store automatically, once, with an audit row; nothing demotes it', async () => {
    expect((await vendor()).tier).toBe('UNREGISTERED');
    expect(await system(() => promoteIfRegistered(app.prisma, ownerUserId))).toEqual([]); // no record yet
    // A registration whose record has EXPIRED proves nothing: no promotion.
    const stale = await system(() => app.prisma.verificationDocument.create({ data: {
      userId: ownerUserId, role: 'VENDOR_OWNER', docType: REGISTRATION_DOC_TYPES[0]!, fileUrl: `storage://t/${RUN}-old.jpg`, status: 'APPROVED', reviewedAt: new Date(), reviewedBy: 'admin-fixture', expiresAt: new Date(Date.now() - 86_400_000),
    } as never }));
    expect((await system(() => app.prisma.documentRecord.findFirst({ where: { submissionId: stale.id } })))?.expiresOn).not.toBeNull();
    expect(await system(() => promoteIfRegistered(app.prisma, ownerUserId))).toEqual([]);
    expect((await vendor()).tier).toBe('UNREGISTERED');
    const doc = await system(() => app.prisma.verificationDocument.create({ data: {
      userId: ownerUserId, role: 'VENDOR_OWNER', docType: REGISTRATION_DOC_TYPES[0]!, fileUrl: `storage://t/${RUN}-reg.jpg`, status: 'APPROVED', reviewedAt: new Date(), reviewedBy: 'admin-fixture',
    } as never }));
    // The durable record is kept by trigger from the state machine (P4-2); assert it exists before relying on it.
    const record = await system(() => app.prisma.documentRecord.findFirst({ where: { submissionId: doc.id } }));
    expect(record?.status).toBe('VALID');
    const promoted = await system(() => promoteIfRegistered(app.prisma, ownerUserId));
    expect(promoted).toEqual([vendorId]);
    const after = await vendor();
    expect(after.tier).toBe('REGISTERED');
    expect(after.tierChangedAt).not.toBeNull();
    expect(await system(() => app.prisma.auditLog.count({ where: { action: 'VENDOR_TIER_PROMOTED', entityId: vendorId } }))).toBe(1);
    expect(await system(() => promoteIfRegistered(app.prisma, ownerUserId))).toEqual([]); // idempotent
    await system(() => app.prisma.verificationDocument.update({ where: { id: doc.id }, data: { status: 'EXPIRED' } }));
    expect((await vendor()).tier).toBe('REGISTERED'); // a lapse is a review case, never an automatic demotion
  });

  it('the registry carries the self-declaration type in the BUSINESS bucket with a 365-day validity', () => {
    const row = EXTRA_DOC_TYPES.find((t) => t.legacyCode === DECLARATION_DOC_TYPE);
    expect(row).toMatchObject({ bucket: 'BUSINESS', hasExpiry: true, defaultValidityDays: 365 });
    expect(BUCKET_OF[DECLARATION_DOC_TYPE]).toBe('BUSINESS');
  });
});

describe('[DOC-1 P3-2] the build against the contract: declaration, requirement set, nudge', () => {
  it('test_unregistered_declaration_route: the owner signs the versioned declaration — consent row, filed PDF document, tier UNREGISTERED, the tier checklist; a registered store is refused', async () => {
    // A second store, registered today, whose owner signs the declaration.
    const o = await mkUser(20, ['VENDOR_OWNER'], 'VENDOR_OWNER'); users.push(o.id);
    const token = app.jwt.sign({ userId: o.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
    await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: o.id, token, refreshToken: nanoid(24), deviceId: `mv2-${NUM}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } }));
    const owner2 = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: o.id, vendors: { create: {
      name: `Home Kitchen ${RUN}`, slug: `home-kitchen-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+5926${NUM}98`, addressLine1: '2 Stall Row', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, status: 'PENDING_APPROVAL',
    } } }, include: { vendors: true } }));
    const v2 = owner2.vendors[0]!.id;
    extraVendorIds.push(v2);
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/vendor/onboarding/declaration', payload: payload as Record<string, unknown>, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-vendor-id': v2 } });
    const res = await post({ tradingName: `Auntie ${RUN}`, activityClass: 'home_cook', declaredAddress: '2 Stall Row, Georgetown', attestationVersion: 'v1' });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data;
    expect(data.tier).toBe('UNREGISTERED');
    expect(data.declaration.docType).toBe(DECLARATION_DOC_TYPE);
    const store = await system(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: v2 }, select: { tier: true, tierNote: true } }));
    expect(store.tier).toBe('UNREGISTERED');
    expect(store.tierNote).toContain('home_cook');
    const consent = await system(() => app.prisma.consentRecord.findFirst({ where: { subjectId: o.id, documentType: DECLARATION_CONSENT_TYPE }, orderBy: { capturedAt: 'desc' } }));
    expect(consent).toMatchObject({ action: 'granted', documentVersion: 'v1' });
    expect((consent?.evidence as { tradingName?: string })?.tradingName).toBe(`Auntie ${RUN}`);
    const filed = await system(() => app.prisma.verificationDocument.findFirst({ where: { userId: o.id, docType: DECLARATION_DOC_TYPE } }));
    expect(filed).not.toBeNull();
    // The tier's checklist is what the owner now sees: the declaration is on it, the registration is not.
    const checklist: string[] = data.status.required ?? data.status.checklist ?? [];
    expect(checklist).toContain(DECLARATION_DOC_TYPE);
    expect(checklist).not.toContain(REGISTRATION_DOC_TYPES[0]);
    // Signing twice is refused; a registered store (the first owner holds a VALID registration record) is refused.
    expect((await post({ tradingName: 'x y', activityClass: 'home_cook', declaredAddress: '2 Stall Row, Georgetown', attestationVersion: 'v1' })).json().error.code).toBe('DECLARATION_EXISTS');
    // The first owner holds a VALID, unexpired registration record (the promotion test expired its earlier one).
    await system(() => app.prisma.verificationDocument.create({ data: {
      userId: ownerUserId, role: 'VENDOR_OWNER', docType: REGISTRATION_DOC_TYPES[0]!, fileUrl: `storage://t/${RUN}-reg2.jpg`, status: 'APPROVED', reviewedAt: new Date(), reviewedBy: 'admin-fixture',
    } as never }));
    const ownerToken = app.jwt.sign({ userId: ownerUserId, role: 'VENDOR_OWNER', jti: nanoid(8) });
    await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: ownerUserId, token: ownerToken, refreshToken: nanoid(24), deviceId: `mv1-${NUM}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } }));
    const registered = await app.inject({ method: 'POST', url: '/api/v1/vendor/onboarding/declaration', payload: { tradingName: 'Reg Store', activityClass: 'snackette', declaredAddress: '1 Stall Row, Georgetown', attestationVersion: 'v1' }, headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json', 'x-vendor-id': vendorId } });
    expect(registered.statusCode).toBe(409);
    expect(registered.json().error.code).toBe('ALREADY_REGISTERED');
  });

  it('GET /vendor/tier: the owner sees the tier, the caps, today\'s and this week\'s usage, the declaration on file and what lifts the limits', async () => {
    const owner = await system(() => app.prisma.vendorOwner.findFirstOrThrow({ where: { vendors: { some: { id: { in: extraVendorIds } } } }, select: { userId: true, vendors: { select: { id: true } } } }));
    const token = app.jwt.sign({ userId: owner.userId, role: 'VENDOR_OWNER', jti: nanoid(8) });
    await runWithTenant('swift-default', () => app.prisma.session.create({ data: { userId: owner.userId, token, refreshToken: nanoid(24), deviceId: `mv3-${NUM}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } }));
    const res = await app.inject({ method: 'GET', url: '/api/v1/vendor/tier', headers: { authorization: `Bearer ${token}`, 'x-vendor-id': owner.vendors[0]!.id } });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json().data;
    expect(t).toMatchObject({ tier: 'UNREGISTERED', capped: true, promotedPlacement: false, caps: { ordersPerDay: 30, grossPerWeek: 150_000 } });
    expect(t.usage).toEqual({ ordersToday: 0, grossThisWeek: 0 });
    expect(t.registration).toEqual({ onFile: false, submission: null });
    expect(t.declaration).toMatchObject({ status: 'PENDING' });
  });

  it('test_micro_vendor_requirement_set: the registry seeds the UNREGISTERED tier set for each store role from the same lists the facade reads', async () => {
    await system(() => seedDocRegistry(app.prisma));
    const set = await system(() => app.prisma.requirementSet.findFirst({ where: { countryCode: 'GY', actorRole: 'RESTAURANT', tier: 'UNREGISTERED' }, include: { items: { include: { docType: { select: { legacyCode: true } } } } } }));
    expect(set).not.toBeNull();
    const codes = set!.items.map((i) => i.docType.legacyCode);
    expect(codes).toEqual(expect.arrayContaining([DECLARATION_DOC_TYPE, 'food_handler_cert', 'storefront_photo', 'owner_national_id']));
    expect(codes).not.toContain(REGISTRATION_DOC_TYPES[0]);
    const facade = await system(() => new CountryConfigService(app.prisma).getDocumentChecklist('GY', 'RESTAURANT', 'UNREGISTERED'));
    expect(facade).toEqual(expect.arrayContaining([DECLARATION_DOC_TYPE, 'food_handler_cert']));
    expect(await system(() => new CountryConfigService(app.prisma).getDocumentChecklist('GY', 'RESTAURANT'))).toContain(REGISTRATION_DOC_TYPES[0]);
  });

  it('test_nudge_at_sixty_percent: a checkout that lands the store at 60 % of a cap tells the owner once a day, with the DCRA steps', async () => {
    await system(() => app.prisma.vendor.update({ where: { id: vendorId }, data: { tier: 'UNREGISTERED' } }));
    await system(() => app.prisma.order.deleteMany({ where: { vendorId, orderNumber: { startsWith: `MV${NUM}` } } }));
    const now = new Date();
    for (let i = 0; i < Math.ceil(VENDOR_TIER_CAPS_DEFAULTS.ordersPerDay * VENDOR_TIER_CAPS_DEFAULTS.nudgeAtFraction) - 1; i += 1) await placedOrder(1000, new Date(now.getTime() - 60_000));
    const inject = (method: 'POST', url: string, payload: unknown) => app.inject({ method, url, payload: payload as Record<string, unknown>, headers: { authorization: `Bearer ${customerToken}`, 'content-type': 'application/json' } });
    const nudges = () => system(() => app.prisma.notification.count({ where: { data: { path: ['kind'], equals: 'vendor_tier_nudge' }, AND: [{ data: { path: ['vendorId'], equals: vendorId } }] } }));
    const before = await nudges();
    await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 });
    const first = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } });
    expect(first.statusCode, first.body).toBe(200);
    expect(await nudges()).toBe(before + 1);
    const note = await system(() => app.prisma.notification.findFirst({ where: { data: { path: ['kind'], equals: 'vendor_tier_nudge' }, AND: [{ data: { path: ['vendorId'], equals: vendorId } }] }, orderBy: { createdAt: 'desc' } }));
    expect(note?.body).toContain('DCRA');
    await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 });
    const second = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } });
    expect(second.statusCode).toBe(200);
    expect(await nudges()).toBe(before + 1); // once a day
  });
});
