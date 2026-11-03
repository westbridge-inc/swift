/**
 * [TENANT-WALL · 1 Nov 2026] A partner's signed statement link opens under
 * production's CONTRACT tenant posture.
 *
 * GET /api/v1/statements/render is opened from a short-lived signed link,
 * without a session, so nothing binds a tenant for it. Under the posture (the
 * app's own client on a least-privilege login that does not bypass row
 * security, system work on its own bypass-member login, TENANT_RLS_BIND=1 and
 * TENANT_UNSCOPED_ACCESS=deny) every read of the ledger it builds the
 * statement from was refused (TENANT_CONTEXT_REQUIRED, a 500): no store, rider
 * or driver could open, print or share a statement. The route's other suites
 * run with no posture, where the same reads run unbound and pass.
 *
 * Measured here through the app's own client on a per-suite walled login,
 * with the same request context boundary as server.ts:
 *  - a store's sales statement, a rider's and a driver's earnings statement
 *    render with their true totals (the store's from the SQL aggregate), for
 *    holders of TWO operators, each read in its own operator;
 *  - every refusal still answers as it did: a tampered signature (403), an
 *    expired link (410), a validly signed link for a holder that does not
 *    exist (404);
 *  - the system work is at most ONE read (the holder's operator) under its own
 *    capability, and nothing else is read as system work;
 *  - the wall still binds the app: its login neither bypasses row security
 *    nor joins the bypass role.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
/** Two operators of this suite's own: a read bound to any other tenant sees none of their rows. */
const TENANT_A = `stwall-a-${RUN}`;
const TENANT_B = `stwall-b-${RUN}`;
const PERIOD = { from: new Date(Date.now() - 7 * 86_400_000), to: new Date(Date.now() + 86_400_000) };

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
let statement: typeof import('../modules/order/statement');

const userIds: string[] = [];
const ids = { vendorOwner: '', vendor: '', rider: '', driver: '', storeOrder: '', riderOrder: '', driverOrder: '' };

async function person(tenantId: string, firstName: string, roles: string[]) {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName, lastName: `Wall${RUN}`, tenantId, isPhoneVerified: true,
    roles: roles as never[], activeRole: roles[0] as never,
  } });
  userIds.push(user.id);
  return user.id;
}

async function order(tenantId: string, customerId: string, extra: { orderType: string; vendorId?: string; riderId?: string; driverId?: string; taxiFareTotal?: number }, n: string) {
  const { orderType, ...links } = extra;
  const o = await owner.order.create({ data: {
    tenantId, orderNumber: `STW-${RUN}-${n}`, customerId, orderType: orderType as never, status: 'DELIVERED' as never, fulfillment: 'DELIVERY' as never,
    deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15, placedAt: new Date(), deliveredAt: new Date(),
    subtotalBase: 5000, subtotalMarkup: 0, subtotalCustomer: 5000, discount: 500, deliveryFee: 600, tipAmount: 200, totalAmount: 5300,
    paymentMethod: 'CASH' as never, ...links,
  } });
  return o.id;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  for (const id of [TENANT_A, TENANT_B]) await owner.tenant.create({ data: { id, name: 'Statement wall tenant', slug: id, isActive: true } });

  // A store of operator A with one completed order: 5,000 of goods less its own 500 promotion.
  const customerA = await person(TENANT_A, 'Cust', ['CUSTOMER']);
  const storeOwner = await person(TENANT_A, 'Sita', ['VENDOR_OWNER']);
  ids.vendorOwner = (await owner.vendorOwner.create({ data: { userId: storeOwner } })).id;
  ids.vendor = (await owner.vendor.create({ data: {
    tenantId: TENANT_A, ownerId: ids.vendorOwner, name: `Wall Diner ${RUN}`, slug: `stwall-${RUN}`, vendorType: 'RESTAURANT',
    phone: testPhone(), addressLine1: '3 Ledger Lane', city: 'Georgetown', region: 'Demerara', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', isVerified: true,
  } })).id;
  ids.storeOrder = await order(TENANT_A, customerA, { orderType: 'FOOD_DELIVERY', vendorId: ids.vendor }, 'store');

  // A rider of operator B with a fee and a tip (800 earned).
  const customerB = await person(TENANT_B, 'Cust', ['CUSTOMER']);
  const riderUser = await person(TENANT_B, 'Ravi', ['MOVER']);
  ids.rider = (await owner.rider.create({ data: { userId: riderUser, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } })).id;
  ids.riderOrder = await order(TENANT_B, customerB, { orderType: 'COURIER', riderId: ids.rider }, 'rider');
  for (const [type, amount] of [['DELIVERY_FEE', 600], ['TIP', 200]] as const) {
    await owner.earning.create({ data: { tenantId: TENANT_B, riderId: ids.rider, orderId: ids.riderOrder, type: type as never, amount } });
  }

  // A driver of operator A with one fare (1,500 earned).
  const driverUser = await person(TENANT_A, 'Deo', ['DRIVER']);
  ids.driver = (await owner.driver.create({ data: {
    userId: driverUser, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver',
    licensePlate: `PST ${RUN.slice(0, 4)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } })).id;
  ids.driverOrder = await order(TENANT_A, customerA, { orderType: 'TAXI', driverId: ids.driver, taxiFareTotal: 1500 }, 'driver');
  await owner.earning.create({ data: { tenantId: TENANT_A, driverId: ids.driver, orderId: ids.driverOrder, type: 'TAXI_FARE' as never, amount: 1500 } });

  // The app's OWN client on the walled login, system work on the bypass-member login,
  // and the contract's two settings, set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  statement = await import('../modules/order/statement');
  const { redisPlugin } = await import('../plugins/redis');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { statementRoutes } = await import('../modules/order/statement.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(statementRoutes, { prefix: '/api/v1/statements' });
  await app.ready();
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    const orderIds = [ids.storeOrder, ids.riderOrder, ids.driverOrder].filter(Boolean);
    await owner.earning.deleteMany({ where: { orderId: { in: orderIds } } });
    await owner.order.deleteMany({ where: { id: { in: orderIds } } });
    if (ids.vendor) await owner.vendor.deleteMany({ where: { id: ids.vendor } });
    if (ids.vendorOwner) await owner.vendorOwner.deleteMany({ where: { id: ids.vendorOwner } });
    if (ids.rider) await owner.rider.deleteMany({ where: { id: ids.rider } });
    if (ids.driver) await owner.driver.deleteMany({ where: { id: ids.driver } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const link = (kind: 'vendor' | 'rider' | 'driver', actor: string) => statement.mintStatementPath(kind, actor, PERIOD).path;
const open = (path: string) => app.inject({ method: 'GET', url: path });
const refusal = (res: { statusCode: number; json: () => { error?: { code?: string } } }) => [res.statusCode, res.json().error?.code];

/** System reads by model and capability, from the wall's own counter. */
async function systemReads(): Promise<Map<string, number>> {
  const { tenantUnscopedAccessCounter } = await import('../plugins/observability');
  const out = new Map<string, number>();
  for (const v of (await tenantUnscopedAccessCounter.get()).values) {
    if (v.labels['mode'] !== 'system') continue;
    const key = `${v.labels['capability']}|${v.labels['model']}.${v.labels['operation']}`;
    out.set(key, (out.get(key) ?? 0) + v.value);
  }
  return out;
}

describe('[TENANT-WALL] signed statement links under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('a store’s sales statement renders with its true total: goods less its own promotion, fees excluded', async () => {
    const res = await open(link('vendor', ids.vendor));
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain(`STW-${RUN}-store`);
    expect(res.body).toContain(`Wall Diner ${RUN}`);
    expect(res.body).toContain('$4,500 GYD');
  });

  it('a rider of ANOTHER operator: the earnings statement renders, read in that operator', async () => {
    const res = await open(link('rider', ids.rider));
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.body).toContain(`STW-${RUN}-rider`);
    expect(res.body).toContain('Ravi');
    expect(res.body).toContain('$800 GYD');
  });

  it('a driver’s earnings statement renders', async () => {
    const res = await open(link('driver', ids.driver));
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.body).toContain(`STW-${RUN}-driver`);
    expect(res.body).toContain('Deo');
    expect(res.body).toContain('$1,500 GYD');
  });

  it('a tampered signature, an expired link and a link for a holder that does not exist answer as before', async () => {
    const path = link('vendor', ids.vendor);
    const tampered = path.replace(/sig=([0-9a-f])/, (_m, c: string) => `sig=${c === '0' ? '1' : '0'}`);
    expect(tampered).not.toBe(path);
    expect(refusal(await open(tampered))).toEqual([403, 'BAD_SIGNATURE']);
    expect(refusal(await open(path.replace(/expires=\d+/, 'expires=1000000000')))).toEqual([410, 'LINK_EXPIRED']);
    for (const kind of ['vendor', 'rider', 'driver'] as const) {
      expect(refusal(await open(link(kind, `missing-${RUN}`))), kind).toEqual([404, 'NOT_FOUND']);
    }
  });

  it('the system work is at most ONE read (the holder’s operator) under its own capability; nothing else runs as system work', async () => {
    const { STATEMENT_RENDER_LINK_CAPABILITY } = await import('../modules/order/statement.routes');
    for (const [kind, actor, expected] of [
      ['vendor', ids.vendor, [`${STATEMENT_RENDER_LINK_CAPABILITY}|Vendor.findUnique`]],
      // a mover's account is read through the mover row, which carries no tenant of its own
      ['rider', ids.rider, []],
      ['driver', ids.driver, []],
    ] as const) {
      const before = await systemReads();
      expect((await open(link(kind, actor))).statusCode, kind).toBe(200);
      const after = await systemReads();
      // (One read counts on the request client and again on the system connection it is re-issued on.)
      expect([...after].filter(([key, n]) => n !== (before.get(key) ?? 0)).map(([key]) => key), kind).toEqual(expected);
    }
  });
});
