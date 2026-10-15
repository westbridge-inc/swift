/**
 * [W0 · SCOPE-299 S1-A] Every model's queries are bound under the CONTRACT
 * posture — not only the models that carry a tenantId.
 *
 * Under the walled login (a NOBYPASSRLS request login, TENANT_RLS_BIND=1, RLS
 * forced on every tenantId table) a statement that runs without
 * `app.current_tenant` sees ZERO rows of any walled table. The tenant binding
 * wrapped only the tenant models, so a query on a model WITHOUT a tenantId ran
 * unbound: its nested includes and relation filters into walled tables (users,
 * vendors, items, zones…) read nothing. A required relation then throws, a
 * relation filter returns no rows, and system work on such a model stayed on
 * the walled login instead of the system login.
 *
 * Measured here, through the app's OWN client on a per-suite walled login and
 * system work on its own bypass-member login, exactly as production's contract
 * posture runs them:
 *  - a store owner's vendor routes resolve the store (VendorOwner → vendors);
 *  - a driver route resolves the driver (Driver → user, a required relation);
 *  - the rider profile reads (Rider → user, operatingZones);
 *  - the cart reads its store (Cart filtered on, and joined to, the vendor);
 *  - dispatch's offer re-check sees a free online rider (Rider counted through
 *    its account) inside the dispatch job's tenant binding;
 *  - a system job's mover selection (the compliance sample) sees movers through
 *    their accounts, and the verification SLA sweep reads its documents' owners;
 *  - the review send seal can tell a demo device apart, so it suppresses a push
 *    to the fiction instead of failing open on a hidden account;
 * and the wall still holds: a read bound to ANOTHER tenant sees none of these
 * rows' walled relations.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const PRODUCTION = 'swift-default';
const REVIEW = `w0-review-${RUN}`;
const DAY = 86_400_000;
const phone = () => `+5928${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

type PrismaModule = typeof import('../plugins/prisma');
type TenantModule = typeof import('../plugins/tenant-context');
let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: PrismaModule;
let tenant: TenantModule;
let jobs: typeof import('../jobs/queue');

const ids = {
  vendorOwnerUser: '', vendorOwner: '', vendor: '', category: '', item: '',
  driverUser: '', driver: '', riderUser: '', rider: '', customerUser: '', cart: '',
  reviewUser: '', reviewDevice: '', pendingDoc: '', order: '',
};
const tokens: Record<'vendor' | 'driver' | 'rider' | 'customer', string> = { vendor: '', driver: '', rider: '', customer: '' };

async function sessionFor(userId: string, role: string): Promise<string> {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await owner.session.create({ data: { userId, token, refreshToken: nanoid(48), deviceId: `w0-${RUN}-${role}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return token;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  // The fixture writer: the suite's own privileged connection (never the app's client).
  owner = new PrismaClient({ datasourceUrl: TEST_URL });
  logins = await createTenantProbeLogins(owner, TEST_URL);

  await owner.tenant.create({ data: { id: REVIEW, name: 'W0 fiction', slug: REVIEW, kind: 'REVIEW', isActive: false } });
  const mk = (roles: string[], activeRole: string, extra: Record<string, unknown> = {}) => owner.user.create({ data: {
    phone: phone(), firstName: 'Wall', lastName: `W0${RUN}`, roles: roles as never, activeRole: activeRole as never,
    isPhoneVerified: true, tenantId: PRODUCTION, lastActiveAt: new Date(), ...extra,
  } });

  // A store owner, the store, one item in one category.
  ids.vendorOwnerUser = (await mk(['CUSTOMER', 'VENDOR_OWNER'], 'VENDOR_OWNER')).id;
  ids.vendorOwner = (await owner.vendorOwner.create({ data: { userId: ids.vendorOwnerUser } })).id;
  ids.vendor = (await owner.vendor.create({ data: {
    ownerId: ids.vendorOwner, name: `W0 Store ${RUN}`, slug: `w0-store-${RUN}`, vendorType: 'RESTAURANT',
    phone: phone(), addressLine1: '1 Wall St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551,
    tenantId: PRODUCTION, status: 'ACTIVE', isVerified: true,
  } })).id;
  ids.category = (await owner.category.create({ data: { vendorId: ids.vendor, name: 'W0', tenantId: PRODUCTION } })).id;
  ids.item = (await owner.item.create({ data: { vendorId: ids.vendor, categoryId: ids.category, name: 'W0 Roti', basePrice: 900, tenantId: PRODUCTION } })).id;

  // A driver, a rider who is online and free, a customer with a cart at the store.
  ids.driverUser = (await mk(['CUSTOMER', 'MOVER', 'DRIVER'], 'DRIVER', { lastMoverRole: 'DRIVER' })).id;
  ids.driver = (await owner.driver.create({ data: {
    userId: ids.driverUser, vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2016, vehicleColor: 'White',
    licensePlate: `PW${RUN.slice(0, 4).toUpperCase()}`, driverLicenseUrl: 'test://licence', vehicleInsuranceUrl: 'test://insurance',
  } })).id;
  ids.riderUser = (await mk(['CUSTOMER', 'MOVER', 'RIDER'], 'RIDER', { lastMoverRole: 'RIDER' })).id;
  ids.rider = (await owner.rider.create({ data: {
    userId: ids.riderUser, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', isOnline: true, isAvailable: true, locationSessionId: `w0-${RUN}`,
  } })).id;
  ids.customerUser = (await mk(['CUSTOMER'], 'CUSTOMER')).id;
  ids.cart = (await owner.cart.create({ data: { customerId: ids.customerUser, vendorId: ids.vendor } })).id;
  await owner.cartItem.create({ data: { cartId: ids.cart, itemId: ids.item, quantity: 2, selectedOptions: [] } });
  // The object a dispatch job works for: an order at the store, waiting for a rider.
  ids.order = (await owner.order.create({ data: {
    orderNumber: `W0-${RUN}`, orderType: 'FOOD_DELIVERY', customerId: ids.customerUser, vendorId: ids.vendor, tenantId: PRODUCTION,
    deliveryAddress: '2 Wall St', deliveryLat: 6.805, deliveryLng: -58.15,
    subtotalBase: 1800, subtotalMarkup: 0, subtotalCustomer: 1800, deliveryFee: 500, totalAmount: 2300, paymentMethod: 'CASH',
  } })).id;

  // A demo (REVIEW) account with a push device, and a document waiting past the review SLA.
  ids.reviewUser = (await owner.user.create({ data: {
    phone: phone(), firstName: 'Demo', lastName: `W0${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: REVIEW, isPhoneVerified: true,
  } })).id;
  ids.reviewDevice = `w0-demo-device-${RUN}`;
  await owner.deviceToken.create({ data: { userId: ids.reviewUser, token: ids.reviewDevice, platform: 'ios' } });
  ids.pendingDoc = (await owner.verificationDocument.create({ data: {
    userId: ids.riderUser, role: 'RIDER', docType: 'drivers_license', fileUrl: `w0/${RUN}/doc`, status: 'PENDING', createdAt: new Date(Date.now() - 3 * DAY),
  } })).id;

  // The app's OWN client on the walled login, system work on the bypass-member login, and the
  // contract's two application settings — set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  tenant = await import('../plugins/tenant-context');
  jobs = await import('../jobs/queue');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { registerEmptyJsonBodyParser } = await import('../plugins/empty-json');
  const { vendorRoutes } = await import('../modules/vendor/vendor.routes');
  const { driverRoutes } = await import('../modules/driver/driver.routes');
  const { riderRoutes } = await import('../modules/rider/rider.routes');
  const { customerRoutes } = await import('../modules/user/customer.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { tenant.beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();

  tokens.vendor = await sessionFor(ids.vendorOwnerUser, 'VENDOR_OWNER');
  tokens.driver = await sessionFor(ids.driverUser, 'DRIVER');
  tokens.rider = await sessionFor(ids.riderUser, 'RIDER');
  tokens.customer = await sessionFor(ids.customerUser, 'CUSTOMER');
});

afterAll(async () => {
  try {
    await app?.close();
    // The system login's client is cached by the module: close it before its URL leaves the environment.
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    const users = [ids.vendorOwnerUser, ids.driverUser, ids.riderUser, ids.customerUser, ids.reviewUser].filter(Boolean);
    if (ids.pendingDoc) {
      await owner.reviewCase.deleteMany({ where: { submissionId: ids.pendingDoc } });
      await owner.verificationDocument.deleteMany({ where: { id: ids.pendingDoc } });
    }
    if (ids.order) await owner.order.deleteMany({ where: { id: ids.order } });
    if (ids.cart) await owner.cartItem.deleteMany({ where: { cartId: ids.cart } });
    if (ids.cart) await owner.cart.deleteMany({ where: { id: ids.cart } });
    if (users.length) {
      await owner.session.deleteMany({ where: { userId: { in: users } } });
      await owner.deviceToken.deleteMany({ where: { userId: { in: users } } });
    }
    if (ids.item) await owner.item.deleteMany({ where: { id: ids.item } });
    if (ids.category) await owner.category.deleteMany({ where: { id: ids.category } });
    if (ids.vendor) await owner.vendor.deleteMany({ where: { id: ids.vendor } });
    if (ids.vendorOwner) await owner.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } });
    if (ids.driver) await owner.driver.deleteMany({ where: { id: ids.driver } });
    if (ids.rider) await owner.rider.deleteMany({ where: { id: ids.rider } });
    if (users.length) await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.tenant.deleteMany({ where: { id: REVIEW } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
/** Run `fn` as the worker runs a job: from NO ambient context (a BullMQ worker has none; an earlier
 *  inject would otherwise leave its request's tenant in this test's context), inside inJobContext
 *  (named system work, job:<queue>:<name>). */
async function asJob<T>(queue: string, name: string, data: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  let out: T | undefined;
  const processor = jobs.inJobContext(queue, async () => { out = await fn(); });
  await tenant.tenantContext.exit(() => processor({ name, attemptsStarted: 1, attemptsMade: 0, data } as never));
  return out as T;
}

describe('[W0] request work on a model without a tenantId is bound to the caller\'s tenant', () => {
  it('a store owner\'s vendor routes resolve the store (VendorOwner → vendors)', async () => {
    const res = await get('/api/v1/vendor/stores', tokens.vendor);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.stores.map((s: { id: string }) => s.id)).toEqual([ids.vendor]);
    expect(data).toMatchObject({ selectedId: ids.vendor, myRole: 'OWNER' });
  });

  it('a driver route resolves the driver (Driver → user, a required relation)', async () => {
    const res = await get('/api/v1/driver/standing', tokens.driver);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the rider profile reads (Rider → user and operating zones)', async () => {
    const res = await get('/api/v1/rider/profile', tokens.rider);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.user).toMatchObject({ id: ids.riderUser });
  });

  it('the cart reads its store and lines (Cart filtered on, and joined to, the walled vendor)', async () => {
    const res = await get('/api/v1/customer/cart', tokens.customer);
    expect(res.statusCode, res.body).toBe(200);
    const cart = res.json().data;
    expect(cart?.vendor?.id).toBe(ids.vendor);
    expect(cart.items.map((l: { itemId: string }) => l.itemId)).toEqual([ids.item]);
  });

  it('dispatch: a free online rider can receive an offer inside the dispatch job\'s tenant binding', async () => {
    const { DispatchService } = await import('../modules/dispatch/dispatch.service');
    const io = { to: () => ({ emit: () => true }) } as never;
    const dispatch = new DispatchService(prismaModule.scopedPrisma, {} as never, io, {} as never);
    const canReceiveOffer = (dispatch as unknown as { canReceiveOffer(pool: 'RIDER' | 'DRIVER', moverId: string, riderCap?: number): Promise<boolean> }).canReceiveOffer.bind(dispatch);
    // The dispatch job as the worker runs it: named system work (inJobContext) that binds the ORDER's
    // tenant (inTenantOf) before it re-checks a candidate.
    const eligible = await asJob('dispatch', 'dispatch-order', { orderId: ids.order }, () =>
      jobs.inTenantOf(prismaModule.scopedPrisma, { order: ids.order }, () => canReceiveOffer('RIDER', ids.rider)));
    expect(eligible).toBe(true);
  });
});

describe('[W0] system work on a model without a tenantId runs on the system login', () => {
  it('the compliance sample\'s mover selection sees movers through their accounts', async () => {
    const activeSince = new Date(Date.now() - 30 * DAY);
    // The exact selection of ComplianceAuditService.sampleForReview, narrowed to this suite's mover.
    const riders = await asJob('verification', 'compliance-sample', {}, () =>
      prismaModule.scopedPrisma.rider.findMany({ where: { id: ids.rider, user: { lastActiveAt: { gte: activeSince } } }, select: { userId: true } }));
    expect(riders).toEqual([{ userId: ids.riderUser }]);
  });

  it('the verification SLA sweep reads a waiting document\'s owner (VerificationDocument → user)', async () => {
    // The exact read of VerificationService.alertReviewSlaBreaches, narrowed to this suite's document.
    const docs = await asJob('verification', 'verification-sweep', {}, () =>
      prismaModule.scopedPrisma.verificationDocument.findMany({
        where: { id: ids.pendingDoc, status: 'PENDING', createdAt: { lt: new Date(Date.now() - DAY) } },
        select: { id: true, createdAt: true, user: { select: { tenantId: true } } },
      }));
    expect(docs.map((d) => [d.id, d.user.tenantId])).toEqual([[ids.pendingDoc, PRODUCTION]]);
  });

  it('the review send seal suppresses a push to a demo device (it never fails open on a hidden account)', async () => {
    const { reviewSendSuppression } = await import('../providers/notifications/review-seal');
    expect(await reviewSendSuppression('push', [ids.reviewDevice])).toBe('destination');
  });
});

describe('[W0] the wall still holds for a model without a tenantId', () => {
  it('bound to ANOTHER tenant, a store owner\'s link shows none of the production store', async () => {
    const seen = await tenant.runWithTenant(REVIEW, () => prismaModule.scopedPrisma.vendorOwner.findUnique({
      where: { userId: ids.vendorOwnerUser }, include: { vendors: { select: { id: true } } },
    }));
    expect(seen?.id).toBe(ids.vendorOwner); // the link row itself carries no tenant
    expect(seen?.vendors).toEqual([]);     // the walled store stays invisible to the other tenant
  });

  it('bound to ANOTHER tenant, a relation filter into a production account matches nothing', async () => {
    const n = await tenant.runWithTenant(REVIEW, () => prismaModule.scopedPrisma.rider.count({ where: { id: ids.rider, user: { status: 'ACTIVE' } } }));
    expect(n).toBe(0);
  });
});

describe('[W0] transactions: a model without a tenantId never leaves the transaction it belongs to', () => {
  const driverWithUser = (db: { driver: PrismaClient['driver'] }) =>
    db.driver.findUnique({ where: { id: ids.driver }, include: { user: { select: { id: true } } } });

  it('inside a transaction that began under the tenant, it reads its relations on the bound connection', async () => {
    const row = await tenant.runWithTenant(PRODUCTION, () => prismaModule.scopedPrisma.$transaction(async (tx) => driverWithUser(tx as unknown as PrismaClient)));
    expect(row?.user.id).toBe(ids.driverUser);
  });

  it('inside a batch transaction begun under the tenant, likewise', async () => {
    const [row] = await tenant.runWithTenant(PRODUCTION, () => prismaModule.scopedPrisma.$transaction([driverWithUser(prismaModule.scopedPrisma)]));
    expect(row?.user.id).toBe(ids.driverUser);
  });

  it('system work in its own transaction reads on the system login', async () => {
    const row = await tenant.runAsSystem('test-w0-system-tx', () => prismaModule.scopedPrisma.$transaction(async (tx) => driverWithUser(tx as unknown as PrismaClient)));
    expect(row?.user.id).toBe(ids.driverUser);
  });

  it('a flow that asks for ANOTHER tenant inside a transaction bound to one is refused by name (never read in the wrong tenant)', async () => {
    await expect(tenant.runWithTenant(PRODUCTION, () => prismaModule.scopedPrisma.$transaction(async (tx) =>
      tenant.runWithTenant(REVIEW, () => (tx as unknown as PrismaClient).vendorOwner.findUnique({
        where: { userId: ids.vendorOwnerUser }, include: { vendors: { select: { id: true } } },
      })))))
      .rejects.toBeInstanceOf(prismaModule.TenantSwitchInTransactionError);
  });
});

describe('[W0] counted, and inert unless TENANT_RLS_BIND=1', () => {
  const kinds = async () => {
    const { tenantBindCounter } = await import('../plugins/observability');
    return Object.fromEntries((await tenantBindCounter.get()).values.map((v) => [v.labels['kind'], v.value])) as Record<string, number | undefined>;
  };
  const ownerLink = () => tenant.runWithTenant(PRODUCTION, () => prismaModule.scopedPrisma.vendorOwner.findUnique({
    where: { userId: ids.vendorOwnerUser }, include: { vendors: { select: { id: true } } },
  }));

  it('a tenant-bound read of a model without a tenantId is counted as nontenant; system work as nontenant_system', async () => {
    const before = await kinds();
    expect((await ownerLink())?.vendors.map((v) => v.id)).toEqual([ids.vendor]);
    await tenant.runAsSystem('test-w0-count', () => prismaModule.scopedPrisma.deviceToken.findMany({ where: { token: ids.reviewDevice }, select: { user: { select: { id: true } } } }));
    const after = await kinds();
    expect((after['nontenant'] ?? 0) - (before['nontenant'] ?? 0)).toBe(1);
    expect((after['nontenant_system'] ?? 0) - (before['nontenant_system'] ?? 0)).toBe(1);
  });

  it('with binding off nothing is bound (the walled login then sees no store: exactly the pre-W0 behaviour)', async () => {
    const before = await kinds();
    process.env['TENANT_RLS_BIND'] = '0';
    try {
      expect((await ownerLink())?.vendors).toEqual([]);
    } finally {
      process.env['TENANT_RLS_BIND'] = '1';
    }
    const after = await kinds();
    expect(after['nontenant'] ?? 0).toBe(before['nontenant'] ?? 0);
  });
});

describe('[W0] the review send seal fails CLOSED under the tenant wall', () => {
  /** A push provider that records every send it is asked to make. */
  const recordingPush = () => {
    const sent: string[][] = [];
    return { sent, provider: { sendPush: async (deviceTokens: string[]) => { sent.push(deviceTokens); return { sent: deviceTokens.length, invalidTokens: [] }; } } };
  };
  const productionDevice = `w0-prod-device-${RUN}`;

  it('a production device still receives its push; a demo device is suppressed', async () => {
    await owner.deviceToken.create({ data: { userId: ids.customerUser, token: productionDevice, platform: 'android' } });
    const { sealPush } = await import('../providers/notifications/review-seal');
    const push = recordingPush();
    const sealed = sealPush(push.provider as never);
    await tenant.runAsSystem('test-w0-seal', () => sealed.sendPush([productionDevice], 't', 'b'));
    await tenant.runAsSystem('test-w0-seal', () => sealed.sendPush([ids.reviewDevice], 't', 'b'));
    expect(push.sent).toEqual([[productionDevice]]);
  });

  it('when the seal cannot look the destination up, the send is REFUSED with an error and nothing leaves', async () => {
    const { sealPush, ReviewSealUndecidedError } = await import('../providers/notifications/review-seal');
    const push = recordingPush();
    const sealed = sealPush(push.provider as never);
    // The system login becomes unreachable: every system lookup now fails.
    const dead = new PrismaClient({ datasourceUrl: 'postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1' });
    const live = prismaModule.systemPrismaClient();
    prismaModule.setSystemPrismaClient(dead);
    try {
      await expect(tenant.runAsSystem('test-w0-seal', () => sealed.sendPush([productionDevice], 't', 'b'))).rejects.toBeInstanceOf(ReviewSealUndecidedError);
    } finally {
      prismaModule.setSystemPrismaClient(null);
      await dead.$disconnect().catch(() => {});
      await live?.$disconnect().catch(() => {});
    }
    expect(push.sent).toEqual([]);
  });

  it('with binding off a failed lookup delivers, exactly as before W0', async () => {
    const { sealPush } = await import('../providers/notifications/review-seal');
    const push = recordingPush();
    const sealed = sealPush(push.provider as never);
    process.env['TENANT_RLS_BIND'] = '0';
    try {
      // Unbound on the walled login the device's account is hidden: the lookup throws, the old rule delivers.
      await tenant.runAsSystem('test-w0-seal', () => sealed.sendPush([productionDevice], 't', 'b'));
    } finally {
      process.env['TENANT_RLS_BIND'] = '1';
    }
    expect(push.sent).toEqual([[productionDevice]]);
  });
});
