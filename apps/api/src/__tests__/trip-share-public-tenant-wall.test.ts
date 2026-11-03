/**
 * [TENANT-WALL · 1 Nov 2026] The public trip page (a family member's shared
 * trip link) works under production's CONTRACT tenant posture.
 *
 * GET /api/v1/safety/public/trip/:token is opened without a session, so
 * nothing binds a tenant for it. Under the posture (the app's own client on a
 * least-privilege login that does not bypass row security, system work on its
 * own bypass-member login, TENANT_RLS_BIND=1 and TENANT_UNSCOPED_ACCESS=deny)
 * its read of the link was refused (TENANT_CONTEXT_REQUIRED, a 500): no shared
 * trip could be watched. The service's other suites run with no posture,
 * where the same read runs unbound and passes.
 *
 * Measured here through the app's own client on a per-suite walled login,
 * with the same request context boundary as server.ts:
 *  - a live link shows the trip (first names, the car and its plate, the live
 *    fix) for a trip of ANY operator, each read in its own operator;
 *  - views are still counted;
 *  - every refusal still answers as it did: an unknown or too-short link, a
 *    revoked link, an expired link and a trip whose grace is over are the same
 *    404; a trip that just ended shows its end without a location;
 *  - the system work is ONE read (the link's operator, by its digest) under
 *    its own capability, and nothing else is read as system work;
 *  - the wall still binds the app: its login neither bypasses row security
 *    nor joins the bypass role.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
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
const TENANT_A = `tswall-a-${RUN}`;
const TENANT_B = `tswall-b-${RUN}`;
/** This run's own caller address, so the page's per-caller limits never meet another run's. */
const CALLER = `10.${Number(RUN.slice(0, 2)) % 250}.${Number(RUN.slice(2, 4)) % 250}.${Number(RUN.slice(4, 6)) % 250 + 1}`;
const MINUTE = 60_000;

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
/** The digest a link is stored by (trip-share.service tripShareDigest), computed here: importing the
 *  service before the posture is set would load the app's client on the owner's login. */
const digest = (secret: string): string => createHash('sha256').update(secret).digest('hex');

const userIds: string[] = [];
const driverIds: string[] = [];
const orderIds: string[] = [];
const links = { liveA: '', liveB: '', counted: '', revoked: '', expired: '', justEnded: '', graceOver: '', unknown: '' };

async function person(tenantId: string, firstName: string, roles: string[]) {
  const user = await owner.user.create({ data: {
    phone: testPhone(), firstName, lastName: `Wall${RUN}`, tenantId, isPhoneVerified: true,
    roles: roles as never[], activeRole: roles[0] as never,
  } });
  userIds.push(user.id);
  return user.id;
}

async function trip(tenantId: string, names: { passenger: string; driver: string; plate: string }, opts: { status?: string; deliveredAt?: Date } = {}) {
  const customerId = await person(tenantId, names.passenger, ['CUSTOMER']);
  const driverUserId = await person(tenantId, names.driver, ['DRIVER']);
  const driver = await owner.driver.create({ data: {
    userId: driverUserId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver',
    licensePlate: names.plate, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
    currentLat: 6.8013, currentLng: -58.1553, lastLocationUpdate: new Date(),
  } });
  driverIds.push(driver.id);
  const order = await owner.order.create({ data: {
    tenantId, customerId, driverId: driver.id, orderType: 'TAXI', status: (opts.status ?? 'RIDE_IN_PROGRESS') as never,
    orderNumber: `TSW-${RUN}-${orderIds.length}`, fulfillment: 'DELIVERY',
    pickupAddress: 'Stabroek Market', pickupLat: 6.8045, pickupLng: -58.1622,
    deliveryAddress: '12 Private Street, Georgetown', deliveryLat: 6.8145, deliveryLng: -58.1522,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0,
    totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
    ...(opts.deliveredAt ? { deliveredAt: opts.deliveredAt } : {}),
  } });
  orderIds.push(order.id);
  return { orderId: order.id, customerId };
}

/** A link stored exactly as mint stores one: the digest only, the secret handed back. */
async function link(tenantId: string, t: { orderId: string; customerId: string }, extra: { revokedAt?: Date; expiresAt?: Date } = {}): Promise<string> {
  const secret = randomBytes(32).toString('base64url');
  await owner.tripShareToken.create({ data: {
    tenantId, orderId: t.orderId, createdByUserId: t.customerId, tokenDigest: digest(secret), tokenPrefix: secret.slice(0, 6),
    expiresAt: extra.expiresAt ?? new Date(Date.now() + 60 * MINUTE), ...(extra.revokedAt ? { revokedAt: extra.revokedAt } : {}),
  } });
  return secret;
}

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);

  for (const id of [TENANT_A, TENANT_B]) await owner.tenant.create({ data: { id, name: 'Trip share wall tenant', slug: id, isActive: true } });
  links.liveA = await link(TENANT_A, await trip(TENANT_A, { passenger: 'Asha', driver: 'Deo', plate: `PAA ${RUN.slice(0, 4)}` }));
  links.liveB = await link(TENANT_B, await trip(TENANT_B, { passenger: 'Bibi', driver: 'Ravi', plate: `PBB ${RUN.slice(0, 4)}` }));
  links.counted = await link(TENANT_B, await trip(TENANT_B, { passenger: 'Indra', driver: 'Joel', plate: 'PGG 1' }));
  links.revoked = await link(TENANT_A, await trip(TENANT_A, { passenger: 'Cora', driver: 'Dev', plate: 'PCC 1' }), { revokedAt: new Date() });
  links.expired = await link(TENANT_A, await trip(TENANT_A, { passenger: 'Dina', driver: 'Eli', plate: 'PDD 1' }), { expiresAt: new Date(Date.now() - MINUTE) });
  links.justEnded = await link(TENANT_A, await trip(TENANT_A, { passenger: 'Esha', driver: 'Fay', plate: 'PEE 1' }, { status: 'COMPLETED', deliveredAt: new Date(Date.now() - 5 * MINUTE) }));
  links.graceOver = await link(TENANT_A, await trip(TENANT_A, { passenger: 'Gita', driver: 'Hal', plate: 'PFF 1' }, { status: 'COMPLETED', deliveredAt: new Date(Date.now() - 24 * 60 * MINUTE) }));
  links.unknown = randomBytes(32).toString('base64url');

  // The app's OWN client on the walled login, system work on the bypass-member login,
  // and the contract's two settings, set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { safetyRoutes } = await import('../modules/safety/safety.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
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
    await owner.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
    await owner.order.deleteMany({ where: { id: { in: orderIds } } });
    await owner.driver.deleteMany({ where: { id: { in: driverIds } } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

const view = (token: string) => app.inject({ method: 'GET', url: `/api/v1/safety/public/trip/${token}`, remoteAddress: CALLER });
const notAvailable = (res: { statusCode: number; json: () => { error?: { code?: string } } }) => [res.statusCode, res.json().error?.code];

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

describe('[TENANT-WALL] the public trip page under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('a live link shows the trip: first names, the car and its plate, the live fix, and nothing private', async () => {
    const res = await view(links.liveA);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({
      status: 'Trip in progress', ended: false, passengerFirstName: 'Asha',
      driver: { firstName: 'Deo', vehicle: 'Silver Toyota Allion', plate: `PAA ${RUN.slice(0, 4)}` },
      location: { lat: 6.8013, lng: -58.1553 },
    });
    expect(JSON.stringify(data)).not.toMatch(new RegExp(`Private Street|Wall${RUN}`));
  });

  it('a trip of ANOTHER operator is shown too, read in that operator', async () => {
    const res = await view(links.liveB);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.json().data).toMatchObject({ passengerFirstName: 'Bibi', driver: { firstName: 'Ravi', plate: `PBB ${RUN.slice(0, 4)}` } });
  });

  it('views are still counted', async () => {
    const before = (await owner.tripShareToken.findUnique({ where: { tokenDigest: digest(links.counted) }, select: { viewCount: true } }))!.viewCount;
    expect(before).toBe(0);
    expect((await view(links.counted)).statusCode).toBe(200);
    let after = before;
    for (let i = 0; i < 40 && after === before; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = (await owner.tripShareToken.findUnique({ where: { tokenDigest: digest(links.counted) }, select: { viewCount: true } }))!.viewCount;
    }
    expect(after).toBe(before + 1);
  });

  it('an unknown, too-short, revoked or expired link, and a trip whose grace is over, are the same 404 as before', async () => {
    for (const token of [links.unknown, 'short', links.revoked, links.expired, links.graceOver]) {
      expect(notAvailable(await view(token)), token.slice(0, 6)).toEqual([404, 'SHARE_NOT_AVAILABLE']);
    }
  });

  it('a trip that just ended shows its end, without a location', async () => {
    const res = await view(links.justEnded);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'Trip completed', ended: true, passengerFirstName: 'Esha', location: null });
  });

  it('the system work is ONE read of the link, by its digest, under its own capability; nothing else runs as system work', async () => {
    const { TRIP_SHARE_PUBLIC_LINK_CAPABILITY } = await import('../modules/safety/trip-share.service');
    const counted = async () => (await owner.tripShareToken.findUnique({ where: { tokenDigest: digest(links.liveA) }, select: { viewCount: true } }))!.viewCount;
    const viewsBefore = await counted();
    const before = await systemReads();
    expect((await view(links.liveA)).statusCode).toBe(200);
    // the view's own count has landed too, so every query of this view is in the counter
    for (let i = 0; i < 40 && (await counted()) === viewsBefore; i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(await counted()).toBe(viewsBefore + 1);
    const after = await systemReads();
    // (One read counts on the request client and again on the system connection it is re-issued on.)
    const grew = [...after].filter(([key, n]) => n !== (before.get(key) ?? 0)).map(([key]) => key);
    expect(grew).toEqual([`${TRIP_SHARE_PUBLIC_LINK_CAPABILITY}|TripShareToken.findUnique`]);
  });
});
