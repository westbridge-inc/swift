/**
 * [STA-1 Part 6] The store-review content pack.
 *
 * A REVIEW tenant provisioned for App Store / Play review gets five fictional
 * stores with GYD menus, categories and hours. The pack:
 *   - lands ONLY in a purge-protected REVIEW tenant — swift-default, a
 *     PRODUCTION tenant wearing a review-looking slug, a CRAWLER tenant, an
 *     unprotected or misnamed REVIEW tenant and a missing tenant are refused
 *     before any write;
 *   - is idempotent (same ids, same counts on every run);
 *   - is reported PRESENT by review:status once seeded;
 *   - is browsable by the review customer through the public customer routes
 *     (and by nobody else), pictures included;
 *   - survives the daily vendor-activation belt;
 *   - carries no money rail: checkout is refused with a friendly message
 *     before any order, outbox row or provider call (DL-5).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerPublicUploads } from '../utils/public-uploads';
import { runWithoutTenant, beginRequestTenantContext } from '../plugins/tenant-context';
import { provisionReviewTenant, reviewStatus } from '../modules/review/provision';
import {
  seedReviewContentPack, planReviewContentPack, reviewContentPackFacts, REVIEW_PACK_STORES,
  PACK_NAME_DENYLIST, PACK_OWNER_PHONE_PREFIX, ReviewTenantRefusedError,
} from '../modules/review/content-pack';
import { REVIEW_DEMO_NO_ORDERS, REVIEW_DEMO_NO_ORDERS_MESSAGE } from '../modules/review/demo-policy';
import { PACK_IMAGE_WIDTH, PACK_IMAGE_HEIGHT, crc32 } from '../modules/review/pack-image';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { SandboxKycProvider } from '../providers/kyc/kyc-provider';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REVIEW = `review-pack-${RUN}`;
/** A PRODUCTION tenant wearing a review-looking, purge-protected disguise. */
const IMPOSTOR = `review-fake-${RUN}`;
const CRAWLER = `review-crawl-${RUN}`;
/** A REVIEW tenant that is not purge-protected, and one whose id does not name the fiction. */
const UNPROTECTED = `review-open-${RUN}`;
const MISNAMED = `fiction-${RUN}`;
const OTHERS = [IMPOSTOR, CRAWLER, UNPROTECTED, MISNAMED];
const PRODUCTION = 'swift-default';
const UPLOAD_DIR = `/tmp/review-pack-test-uploads-${RUN}`;

let app: FastifyInstance;
let customerId = '';
let token = '';
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'review-content-pack-test');
const plan = () => planReviewContentPack(REVIEW);
const get = (url: string, bearer?: string) => app.inject({ method: 'GET', url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

const TOTAL_ITEMS = REVIEW_PACK_STORES.reduce((n, s) => n + s.categories.reduce((m, c) => m + c.items.length, 0), 0);
const TOTAL_CATEGORIES = REVIEW_PACK_STORES.reduce((n, s) => n + s.categories.length, 0);

/** Every table the pack writes, counted globally and in swift-default. */
async function census() {
  return system(async () => ({
    users: await app.prisma.user.count(),
    vendors: await app.prisma.vendor.count(),
    categories: await app.prisma.category.count(),
    items: await app.prisma.item.count(),
    vendorOwners: await app.prisma.vendorOwner.count(),
    hours: await app.prisma.operatingHours.count(),
    prodUsers: await app.prisma.user.count({ where: { tenantId: PRODUCTION } }),
    prodVendors: await app.prisma.vendor.count({ where: { tenantId: PRODUCTION } }),
    prodCategories: await app.prisma.category.count({ where: { tenantId: PRODUCTION } }),
    prodItems: await app.prisma.item.count({ where: { tenantId: PRODUCTION } }),
  }));
}
let before: Awaited<ReturnType<typeof census>>;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['UPLOAD_DIR'] = UPLOAD_DIR;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  registerPublicUploads(app, UPLOAD_DIR);
  await app.ready();

  // The real path: the operator's provision command makes the tenant and the reviewer.
  const provisioned = await system(() => provisionReviewTenant(app.prisma, { slug: REVIEW, phonePrefix: '+59200095' }));
  const reviewer = await system(() => app.prisma.user.findUniqueOrThrow({ where: { phone: provisioned.credentials[0]!.identifier } }));
  customerId = reviewer.id;
  await system(async () => {
    await app.prisma.tenant.create({ data: { id: IMPOSTOR, name: 'Impostor', slug: IMPOSTOR, kind: 'PRODUCTION', purgeProtected: true } });
    await app.prisma.tenant.create({ data: { id: CRAWLER, name: 'Crawler', slug: CRAWLER, kind: 'CRAWLER', purgeProtected: true } });
    await app.prisma.tenant.create({ data: { id: UNPROTECTED, name: 'Unprotected review', slug: UNPROTECTED, kind: 'REVIEW', purgeProtected: false } });
    await app.prisma.tenant.create({ data: { id: MISNAMED, name: 'Misnamed review', slug: MISNAMED, kind: 'REVIEW', purgeProtected: true } });
  });
  token = app.jwt.sign({ userId: customerId, role: 'CUSTOMER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: {
    userId: customerId, token, refreshToken: nanoid(64), authMethod: 'OTP',
    deviceId: `pack-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000),
  } }));
  before = await census();
});

afterAll(async () => {
  await system(async () => {
    // A regression that let checkout through would leave orders behind; clear them first.
    await app.prisma.orderOutbox.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: customerId } });
    await app.prisma.order.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId } } });
    await app.prisma.cart.deleteMany({ where: { customerId } });
    await app.prisma.session.deleteMany({ where: { userId: customerId } });
    await app.prisma.customer.deleteMany({ where: { userId: customerId } });
    // Every tenant the pack could have reached (a weakened guard would write into the others).
    for (const t of [REVIEW, ...OTHERS]) {
      const p = planReviewContentPack(t);
      const vendorIds = p.vendors.map((v) => v.id);
      await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.operatingHours.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await app.prisma.vendorOwner.deleteMany({ where: { userId: p.ownerUserId } });
      await app.prisma.user.deleteMany({ where: { id: p.ownerUserId } });
    }
    await app.prisma.reviewCredential.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.user.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.tenant.updateMany({ where: { id: { in: [REVIEW, ...OTHERS] } }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: { in: [REVIEW, ...OTHERS] } } });
  });
  await app.close();
});

describe('[STA-1 Part 6] the tenant guard', () => {
  it('refuses swift-default, a PRODUCTION tenant wearing a review slug, a CRAWLER tenant, an unprotected or misnamed REVIEW tenant and a missing tenant — and writes nothing anywhere', async () => {
    const refusal = async (slug: string) => {
      const err = await system(() => seedReviewContentPack(app.prisma, { slug })).catch((e: unknown) => e);
      expect(err, slug).toBeInstanceOf(ReviewTenantRefusedError);
      return (err as Error).message;
    };
    expect(await refusal(PRODUCTION)).toMatch(/slug must match/);
    expect(await refusal(IMPOSTOR)).toMatch(/PRODUCTION, not REVIEW/);
    expect(await refusal(CRAWLER)).toMatch(/CRAWLER, not REVIEW/);
    expect(await refusal(UNPROTECTED)).toMatch(/not purge-protected/);
    expect(await refusal(MISNAMED)).toMatch(/slug must match/);
    expect(await refusal(`review-missing-${RUN}`)).toMatch(/no such tenant/);
    expect(await census()).toEqual(before);
    for (const t of [PRODUCTION, ...OTHERS]) {
      expect(await system(() => app.prisma.vendor.count({ where: { tenantId: t, id: { in: planReviewContentPack(t).vendors.map((v) => v.id) } } }))).toBe(0);
    }
  });
});

describe('[STA-1 Part 6] seeding a REVIEW tenant', () => {
  it('status says ABSENT before the seed, PRESENT after it: 4–6 stores, 6–12 GYD items each, categories and hours', async () => {
    expect((await system(() => reviewStatus(app.prisma, REVIEW))).contentPack).toBe('ABSENT');
    const r = await system(() => seedReviewContentPack(app.prisma, { slug: REVIEW }));
    expect(r).toMatchObject({ tenantId: REVIEW, state: 'PRESENT', stores: REVIEW_PACK_STORES.length, orderableStores: REVIEW_PACK_STORES.length, items: TOTAL_ITEMS, categories: TOTAL_CATEGORIES });
    expect(REVIEW_PACK_STORES.length).toBeGreaterThanOrEqual(4);
    expect(REVIEW_PACK_STORES.length).toBeLessThanOrEqual(6);
    expect(new Set(REVIEW_PACK_STORES.map((s) => s.vendorType))).toEqual(new Set(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']));
    for (const store of REVIEW_PACK_STORES) {
      const n = store.categories.reduce((m, c) => m + c.items.length, 0);
      expect(n, store.key).toBeGreaterThanOrEqual(6);
      expect(n, store.key).toBeLessThanOrEqual(12);
    }
    const s = await system(() => reviewStatus(app.prisma, REVIEW));
    expect(s.contentPack).toBe('PRESENT');
    const vendors = await system(() => app.prisma.vendor.findMany({ where: { id: { in: plan().vendors.map((v) => v.id) } }, include: { operatingHours: true } }));
    expect(vendors).toHaveLength(REVIEW_PACK_STORES.length);
    for (const v of vendors) {
      expect(v.operatingHours).toHaveLength(7);
      expect([v.status, v.isVerified, v.acceptingOrders, v.isCurrentlyOpen, v.isSynthetic]).toEqual(['ACTIVE', true, true, true, true]);
    }
  });

  it('re-running is idempotent: the same ids, the same counts, nothing duplicated', async () => {
    const mid = await census();
    const again = await system(() => seedReviewContentPack(app.prisma, { slug: REVIEW }));
    expect(again.state).toBe('PRESENT');
    expect(await census()).toEqual(mid);
    const p = plan();
    expect(await system(() => app.prisma.item.count({ where: { tenantId: REVIEW } }))).toBe(p.items.length);
    expect(await system(() => app.prisma.category.count({ where: { tenantId: REVIEW } }))).toBe(p.categories.length);
    expect(await system(() => app.prisma.vendor.count({ where: { tenantId: REVIEW } }))).toBe(p.vendors.length);
  });

  it('a darkened store or an edited price is healed back to the pack by re-running', async () => {
    const [first] = plan().vendors;
    const [firstItem] = plan().items;
    await system(async () => {
      await app.prisma.vendor.update({ where: { id: first!.id }, data: { isVerified: false, acceptingOrders: false } });
      await app.prisma.item.update({ where: { id: firstItem!.id }, data: { basePrice: 1, isAvailable: false } });
    });
    expect((await system(() => reviewContentPackFacts(app.prisma, REVIEW))).state).toBe('INCOMPLETE');
    expect((await system(() => seedReviewContentPack(app.prisma, { slug: REVIEW }))).state).toBe('PRESENT');
    const healed = await system(() => app.prisma.item.findUniqueOrThrow({ where: { id: firstItem!.id } }));
    expect([Number(healed.basePrice), healed.isAvailable]).toEqual([firstItem!.item.price, true]);
  });

  it('no row lands outside the REVIEW tenant, and production is untouched', async () => {
    const after = await census();
    const p = plan();
    expect(after.vendors - before.vendors).toBe(p.vendors.length);
    expect(after.items - before.items).toBe(p.items.length);
    expect(after.categories - before.categories).toBe(p.categories.length);
    expect(after.users - before.users).toBe(1); // the synthetic owner
    expect(after.vendorOwners - before.vendorOwners).toBe(1);
    expect(after.hours - before.hours).toBe(p.hours.length);
    expect([after.prodUsers, after.prodVendors, after.prodCategories, after.prodItems]).toEqual([before.prodUsers, before.prodVendors, before.prodCategories, before.prodItems]);
    await system(async () => {
      const vendors = await app.prisma.vendor.findMany({ where: { id: { in: p.vendors.map((v) => v.id) } }, select: { tenantId: true, owner: { select: { user: { select: { tenantId: true, isSynthetic: true } } } } } });
      expect(new Set(vendors.map((v) => v.tenantId))).toEqual(new Set([REVIEW]));
      expect(new Set(vendors.map((v) => v.owner.user.tenantId))).toEqual(new Set([REVIEW]));
      expect(vendors.every((v) => v.owner.user.isSynthetic)).toBe(true);
      const items = await app.prisma.item.findMany({ where: { id: { in: p.items.map((i) => i.id) } }, select: { tenantId: true } });
      expect(items).toHaveLength(p.items.length);
      expect(new Set(items.map((i) => i.tenantId))).toEqual(new Set([REVIEW]));
      const cats = await app.prisma.category.findMany({ where: { id: { in: p.categories.map((c) => c.id) } }, select: { tenantId: true } });
      expect(new Set(cats.map((c) => c.tenantId))).toEqual(new Set([REVIEW]));
      const hours = await app.prisma.operatingHours.findMany({ where: { id: { in: p.hours.map((h) => h.id) } }, select: { vendor: { select: { tenantId: true } } } });
      expect(hours).toHaveLength(p.hours.length);
      expect(new Set(hours.map((h) => h.vendor.tenantId))).toEqual(new Set([REVIEW]));
      const owner = await app.prisma.user.findUniqueOrThrow({ where: { id: p.ownerUserId } });
      expect(owner.phone.startsWith(PACK_OWNER_PHONE_PREFIX)).toBe(true);
      expect([owner.tenantId, owner.isPhoneVerified]).toEqual([REVIEW, false]);
    });
  });

  it('fiction only: no store publishes a phone or an MMG link, and no name carries a real brand', async () => {
    const vendors = await system(() => app.prisma.vendor.findMany({ where: { id: { in: plan().vendors.map((v) => v.id) } } }));
    for (const v of vendors) {
      expect([v.publicPhone, v.mmgPayUrl, v.mmgPayUrlPending]).toEqual([null, null, null]);
      expect(v.addressLine1).toMatch(/\(demo address\)$/);
      expect(v.description).toMatch(/fictional/i);
    }
    const names = REVIEW_PACK_STORES.flatMap((s) => [s.name, ...s.categories.flatMap((c) => c.items.map((i) => i.name))]);
    for (const n of names) for (const bad of PACK_NAME_DENYLIST) expect(n.toLowerCase().includes(bad), `${n} ~ ${bad}`).toBe(false);
  });
});

describe('[STA-1 Part 6] the review customer browses the pack through the public routes', () => {
  it('/vendors and /home list every pack store; a guest never sees them', async () => {
    const ids = plan().vendors.map((v) => v.id);
    const list = await get('/api/v1/customer/vendors?limit=50', token);
    expect(list.statusCode).toBe(200);
    for (const id of ids) expect(list.body).toContain(id);
    const home = await get(`/api/v1/customer/home?lat=6.8013&lng=-58.1551&_=${RUN}`, token);
    expect(home.statusCode).toBe(200);
    const open = (home.json() as { data: { openVendors: Array<{ id: string }> } }).data.openVendors.map((v) => v.id);
    for (const id of ids) expect(open).toContain(id);
    const guest = await get(`/api/v1/customer/vendors?limit=50&g=${RUN}`);
    expect(guest.statusCode).toBe(200);
    for (const id of ids) expect(guest.body).not.toContain(id);
  });

  it('each storefront serves its categories and items in GYD, with a Swift-drawn picture for every item', async () => {
    for (const v of plan().vendors) {
      const res = await get(`/api/v1/customer/vendors/${v.id}`, token);
      expect(res.statusCode, v.store.key).toBe(200);
      const data = (res.json() as { data: { name: string; categories: Array<{ name: string; items: Array<{ id: string; basePrice: number; imageUrl: string | null }> }> } }).data;
      expect(data.name).toBe(v.store.name);
      expect(data.categories.map((c) => c.name)).toEqual(v.store.categories.map((c) => c.name));
      const items = data.categories.flatMap((c) => c.items);
      expect(items).toHaveLength(v.store.categories.reduce((m, c) => m + c.items.length, 0));
      for (const it of items) {
        expect(Number.isInteger(it.basePrice) && it.basePrice > 0).toBe(true);
        expect(it.imageUrl).toMatch(/^\/uploads\/items\/review-pack\/v1\/[a-z0-9-]+--[a-z0-9-]+\.png$/);
      }
    }
  });

  it('every pack picture is a real PNG served by the public uploads route; an undeclared name is a 404', async () => {
    const urls = new Set(plan().items.map((i) => `/uploads/items/review-pack/v1/${i.store.key}--${i.item.key}.png`));
    for (const url of urls) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      const png = res.rawPayload;
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([PACK_IMAGE_WIDTH, PACK_IMAGE_HEIGHT]);
      expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)));
    }
    expect((await get('/uploads/items/review-pack/v1/no-such-store--pepperpot.png')).statusCode).toBe(404);
    expect((await get('/uploads/items/review-pack/v1/hibiscus-row-kitchen--not-on-the-menu.png')).statusCode).toBe(404);
    // An escape is refused before the pack is consulted (encoded, so it reaches the handler intact).
    expect((await get('/uploads/items/review-pack/v1/..%2F..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(400);
  });
});

describe('[STA-1 DL-5] checkout in the fiction', () => {
  it('the reviewer fills a cart and reaches checkout; placing is refused with a friendly message before any order, outbox row or notification', async () => {
    const item = plan().items.find((i) => i.store.vendorType === 'RESTAURANT')!;
    const add = await app.inject({
      method: 'POST', url: '/api/v1/customer/cart/items', headers: { authorization: `Bearer ${token}` },
      payload: { vendorId: item.vendorId, itemId: item.id, quantity: 2 },
    });
    expect(add.statusCode, add.body).toBeLessThan(300);
    const cart = await get('/api/v1/customer/cart', token);
    expect(cart.statusCode).toBe(200);
    expect(cart.body).toContain(item.id);
    for (const paymentMethod of ['CASH', 'MOBILE_MONEY']) {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/customer/checkout',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': `pack-${RUN}-${paymentMethod}` },
        payload: { paymentMethod, fulfillmentSelections: { [item.vendorId]: 'PICKUP' } },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toMatchObject({ success: false, error: { code: REVIEW_DEMO_NO_ORDERS, message: REVIEW_DEMO_NO_ORDERS_MESSAGE } });
    }
    await system(async () => {
      expect(await app.prisma.order.count({ where: { tenantId: REVIEW } })).toBe(0);
      expect(await app.prisma.orderOutbox.count({ where: { tenantId: REVIEW } })).toBe(0);
      expect(await app.prisma.checkoutReceipt.count({ where: { userId: customerId } })).toBe(0);
      expect(await app.prisma.notification.count({ where: { user: { tenantId: REVIEW } } })).toBe(0);
    });
  });

  it('the pack carries no money rail: no subscription, transaction, earning or payment instrument in the tenant', async () => {
    await system(async () => {
      expect(await app.prisma.subscription.count({ where: { vendorId: { in: plan().vendors.map((v) => v.id) } } })).toBe(0);
      expect(await app.prisma.transaction.count({ where: { tenantId: REVIEW } })).toBe(0);
      expect(await app.prisma.earning.count({ where: { tenantId: REVIEW } })).toBe(0);
      expect(await app.prisma.paymentInstrument.count({ where: { tenantId: REVIEW } })).toBe(0);
    });
  });
});

describe('[STA-1 Part 6] the pack survives the daily jobs', () => {
  it('the vendor-activation belt (expiry sweep) does not darken the fiction’s stores: they have no documents by design', async () => {
    const verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), new SandboxKycProvider());
    await system(() => verification.reconcileVendorActivations());
    const facts = await system(() => reviewContentPackFacts(app.prisma, REVIEW));
    expect(facts).toMatchObject({ state: 'PRESENT', orderableStores: REVIEW_PACK_STORES.length });
  });
});
