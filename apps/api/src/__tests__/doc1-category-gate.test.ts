/**
 * [DOC-1 §18.3 · P18-2] test_expired_liquor_licence_blocks_alcohol_orders — DOC-INV-26.
 *
 * Documents control what can be sold. A gated category needs the vendor's
 * licence VALID (approved, unexpired): a tag into it is refused without one
 * (BLOCK_LISTING / BLOCK_ORDER), the feed hides an item whose licence lapsed
 * after it was tagged, and — for alcohol — checkout fails the line too. WARN
 * gates allow and flag. Gate document types are submittable by vendors; a
 * type that still needs a specimen is not (FD-DOC-15).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { marketRoutes } from '../modules/market/market.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { OrderService } from '../modules/order/order.service';
import { DiscoveryService } from '../modules/discovery/discovery.service';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { seedDocRegistry, registryCode, CATEGORY_GATES, EXTRA_DOC_TYPES } from '../modules/verification/doc-registry';
import { blockedCategoryIdsForVendors, submittableGateDocTypes } from '../modules/verification/category-gate';
import type { KycProvider, KycVerificationResult } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const TENANT = 'swift-default';

/** §18.3 seed rules, pinned FROM the spec as literals: [category (slug or kind:KIND), document type, enforcement]. */
const SPEC_GATES: ReadonlyArray<readonly [string, string, string]> = [
  ['alcohol', 'liquor_licence', 'BLOCK_ORDER'],
  ['pharmacy', 'pharmacy_authorisation', 'BLOCK_LISTING'],
  ['meat-poultry', 'sanitary_certificate', 'BLOCK_LISTING'],
  ['kind:CUISINE', 'gra_restaurant_licence', 'BLOCK_LISTING'], ['kind:DISH', 'gra_restaurant_licence', 'BLOCK_LISTING'],
  ['kind:CUISINE', 'food_handler_cert', 'BLOCK_LISTING'], ['kind:DISH', 'food_handler_cert', 'BLOCK_LISTING'],
  ['kind:AISLE', 'trade_licence', 'WARN'], ['kind:RETAIL', 'trade_licence', 'WARN'],
];

let app: FastifyInstance;
let orders: OrderService;
let discovery: DiscoveryService;
let verification: VerificationService;
const users: string[] = [];
const vendorIds: string[] = [];
const createdCategoryIds: string[] = [];
let seq = 0;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'doc1-category-gate-test');

class ManualKyc implements KycProvider {
  async verifyIdentity(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async verifyDocument(): Promise<KycVerificationResult> { return { status: 'pending_manual', referenceToken: `m_${nanoid(6)}` }; }
  async getStatus(): Promise<'pending_manual'> { return 'pending_manual'; }
}

async function user(roles: string[], activeRole: string) {
  seq += 1;
  const u = await runWithTenant(TENANT, () => app.prisma.user.create({ data: {
    phone: `+59278${NUM}${seq}`, firstName: 'Gate', lastName: `User${seq}`, roles: roles as never, activeRole: activeRole as never,
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: `avatars/${RUN}/${seq}.jpg`,
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
  } }));
  users.push(u.id);
  return u.id;
}
async function shop() {
  const ownerUserId = await user(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await runWithTenant(TENANT, () => app.prisma.vendorOwner.create({ data: { userId: ownerUserId } }));
  const vendor = await runWithTenant(TENANT, () => app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Gate Shop ${RUN}${seq}`, slug: `gate-shop-${RUN}-${seq}`, vendorType: 'STORE', phone: `+59279${NUM}${seq}`,
    addressLine1: '1 Gate Lane', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
  } }));
  vendorIds.push(vendor.id);
  const shelf = await runWithTenant(TENANT, () => app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 0 } }));
  // A verified shop HOLDS its checklist — the vendor projection re-checks it whenever any of the owner's documents changes.
  for (const docType of ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo']) await licence(ownerUserId, docType, null);
  return { ownerUserId, vendorId: vendor.id, shelfId: shelf.id };
}
const item = (vendorId: string, shelfId: string, name: string) => runWithTenant(TENANT, () => app.prisma.item.create({ data: { vendorId, categoryId: shelfId, name, basePrice: 1500 } }));
async function category(slug: string, kind: 'RETAIL' | 'AISLE') {
  const existing = await system(() => app.prisma.discoveryCategory.findUnique({ where: { tenantId_slug: { tenantId: TENANT, slug } } }));
  if (existing) return existing;
  const c = await system(() => app.prisma.discoveryCategory.create({ data: { tenantId: TENANT, slug, name: slug, kind, vertical: kind === 'AISLE' ? 'GROCERY' : 'RETAIL', emoji: '🧪', status: 'ACTIVE' } }));
  createdCategoryIds.push(c.id);
  return c;
}
const licence = (ownerUserId: string, docType: string, expiresAt: Date | null) => runWithTenant(TENANT, () => app.prisma.verificationDocument.create({ data: {
  userId: ownerUserId, role: 'VENDOR_OWNER', docType, fileUrl: `verification/${RUN}/${docType}-${nanoid(4)}.enc`, status: 'APPROVED', reviewedBy: 'test', reviewedAt: new Date(), consentAt: new Date(), privacyNoticeVersion: 'v1', expiresAt,
} }));
async function customerWithCart(vendorId: string, itemId: string) {
  const customerId = await user(['CUSTOMER'], 'CUSTOMER');
  await runWithTenant(TENANT, () => app.prisma.address.create({ data: { userId: customerId, label: 'Home', addressLine1: '9 Customer Close', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true } }));
  await runWithTenant(TENANT, () => app.prisma.cart.create({ data: { customerId, vendorId, items: { create: { itemId, quantity: 1, selectedOptions: {} } } } }));
  return customerId;
}
const checkout = (customerId: string, vendorId: string) => runWithTenant(TENANT, () => orders.checkout({ userId: customerId, paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }));
const feed = (slug: string) => app.inject({ method: 'GET', url: `/api/v1/market/items?category=${slug}&limit=50` });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.ready();
  const io = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
  orders = new OrderService(app.prisma, io);
  discovery = new DiscoveryService(app.prisma);
  verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new ManualKyc());
  await system(() => seedDocRegistry(app.prisma));
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.order.deleteMany({ where: { vendorId: { in: vendorIds } } }).catch(() => {});
    await app.prisma.cart.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.itemDiscoveryCategory.deleteMany({ where: { item: undefined, categoryId: { in: createdCategoryIds } } }).catch(() => {});
    await app.prisma.itemDiscoveryCategory.deleteMany({ where: { itemId: { in: (await app.prisma.item.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((i) => i.id) } } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.discoveryCategory.deleteMany({ where: { id: { in: createdCategoryIds } } });
    const docs = await app.prisma.verificationDocument.findMany({ where: { userId: { in: users } }, select: { id: true } });
    await app.prisma.reviewDecision.deleteMany({ where: { case: { submissionId: { in: docs.map((d) => d.id) } } } });
    await app.prisma.reviewCase.deleteMany({ where: { submissionId: { in: docs.map((d) => d.id) } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

describe('[DOC-1 P18-2] documents control what can be sold', () => {
  it('the registry holds the §18.1 types (inactive, provisional) and exactly the §18.3 gate rows', async () => {
    const types = await system(() => app.prisma.docType.findMany({ where: { code: { in: EXTRA_DOC_TYPES.map((t) => registryCode('GY', t.legacyCode)) } } }));
    // + the §3.2 unregistered-trader self-declaration (P3-2), seeded with the addendum types
    expect(types.map((t) => t.legacyCode).sort()).toEqual(['digital_id', 'liquor_licence', 'nis_employer_reg', 'pharmacy_authorisation', 'sanitary_certificate', 'self_declaration_unregistered', 'trade_licence']);
    expect(types.every((t) => !t.isActive)).toBe(true);
    expect(types.filter((t) => t.needsSpecimen).map((t) => t.legacyCode).sort()).toEqual(['digital_id', 'pharmacy_authorisation']);
    const gates = await system(() => app.prisma.categoryDocumentGate.findMany({ where: { countryCode: 'GY' }, include: { requiredDocType: { select: { legacyCode: true } } } }));
    const got = gates.map((g) => [g.categorySlug ?? `kind:${g.categoryKind}`, g.requiredDocType.legacyCode, g.enforcement] as const).sort((a, b) => a.join().localeCompare(b.join()));
    expect(got).toEqual([...SPEC_GATES].sort((a, b) => a.join().localeCompare(b.join())));
    expect(CATEGORY_GATES.length).toBe(SPEC_GATES.length);
  });

  it('test_expired_liquor_licence_blocks_alcohol_orders: no licence → the alcohol tag is refused; a valid one → listed and orderable; expired → hidden from the feed AND the order fails', async () => {
    const alcohol = await category('alcohol', 'RETAIL');
    const s = await shop();
    const rum = await item(s.vendorId, s.shelfId, `Demerara rum ${RUN}`);
    await expect(runWithTenant(TENANT, () => discovery.addItemTag(rum.id, 'alcohol', 'VENDOR'))).rejects.toMatchObject({ code: 'CATEGORY_GATED' });
    const lic = await licence(s.ownerUserId, 'liquor_licence', new Date(Date.now() + 30 * DAY));
    await runWithTenant(TENANT, () => discovery.addItemTag(rum.id, 'alcohol', 'VENDOR'));
    expect((await system(() => blockedCategoryIdsForVendors(app.prisma, TENANT, [s.vendorId]))).get(s.vendorId)?.has(alcohol.id)).toBe(false);
    const listed = await feed('alcohol');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.items.some((i: { id: string }) => i.id === rum.id)).toBe(true);
    const c1 = await customerWithCart(s.vendorId, rum.id);
    const ok = await checkout(c1, s.vendorId);
    expect(ok.order.id).toBeTruthy();
    // The licence expires at midnight — the sweep marks it, and the item stops being orderable, not merely listed.
    await system(() => app.prisma.verificationDocument.update({ where: { id: lic.id }, data: { expiresAt: new Date(Date.now() - DAY) } }));
    await verification.expireLapsedDocuments();
    expect((await system(() => app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: lic.id } }))).status).not.toBe('APPROVED');
    expect((await system(() => blockedCategoryIdsForVendors(app.prisma, TENANT, [s.vendorId]))).get(s.vendorId)?.has(alcohol.id)).toBe(true);
    const hidden = await feed('alcohol');
    expect(hidden.json().data.items.some((i: { id: string }) => i.id === rum.id)).toBe(false);
    const c2 = await customerWithCart(s.vendorId, rum.id);
    await expect(checkout(c2, s.vendorId)).rejects.toMatchObject({ code: 'CATEGORY_LICENCE_LAPSED' });
  });

  it('BLOCK_LISTING (meat) refuses the tag without a sanitary certificate and allows it with one; WARN (an aisle) allows without a trade licence', async () => {
    const meat = await category('meat-poultry', 'AISLE');
    const s = await shop();
    const chops = await item(s.vendorId, s.shelfId, `Pork chops ${RUN}`);
    await expect(runWithTenant(TENANT, () => discovery.addItemTag(chops.id, meat.slug, 'VENDOR'))).rejects.toMatchObject({ code: 'CATEGORY_GATED' });
    await licence(s.ownerUserId, 'sanitary_certificate', new Date(Date.now() + 90 * DAY));
    await runWithTenant(TENANT, () => discovery.addItemTag(chops.id, meat.slug, 'VENDOR'));
    const produce = await category('produce', 'AISLE');
    const plantain = await item(s.vendorId, s.shelfId, `Plantain ${RUN}`);
    await runWithTenant(TENANT, () => discovery.addItemTag(plantain.id, produce.slug, 'VENDOR')); // WARN: allowed
    expect(await system(() => app.prisma.itemDiscoveryCategory.count({ where: { itemId: plantain.id } }))).toBe(1);
  });

  it('pharmacy is disabled platform-wide (FD-DOC-15): the tag is refused and the authorisation cannot even be submitted; a liquor licence can be', async () => {
    const pharmacy = await category('pharmacy', 'RETAIL');
    const s = await shop();
    const pills = await item(s.vendorId, s.shelfId, `Paracetamol ${RUN}`);
    await expect(runWithTenant(TENANT, () => discovery.addItemTag(pills.id, pharmacy.slug, 'VENDOR'))).rejects.toMatchObject({ code: 'CATEGORY_GATED' });
    const submittable = await system(() => submittableGateDocTypes(app.prisma, 'GY'));
    expect(submittable).toContain('liquor_licence');
    expect(submittable).not.toContain('pharmacy_authorisation');
    await expect(runWithTenant(TENANT, () => verification.submitDocument(s.ownerUserId, 'STORE', 'pharmacy_authorisation', `/uploads/verification/${RUN}/p.enc`, 'v1'))).rejects.toMatchObject({ code: 'INVALID_DOC_TYPE' });
    const submitted = await runWithTenant(TENANT, () => verification.submitDocument(s.ownerUserId, 'STORE', 'liquor_licence', `/uploads/verification/${RUN}/l.enc`, 'v1'));
    expect(submitted.status).toBe('PENDING');
  });
});
