import { currentTaxiSplitDocuments } from './helpers/current-mover-documents';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance, type InjectOptions, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import fp from 'fastify-plugin';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant, scopedPrisma } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { FareService, formulaFare } from '../modules/rides/fare.service';
import { DEFAULT_TENANT_ID } from '../modules/rides/fare-zones';
import { readTaxiRates } from '../modules/country/pricing-config';
import { adminAuditCounter, adminAuditSnapshotCounter } from '../plugins/observability';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { snapshot, tenantPredicateOf } from '../modules/admin/audit-change';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { injectWithApproval, cleanupSecondApprovers } from './helpers/admin-approval';
import { refusalName, refuseAuditWhere, dropAuditRefusal } from './helpers/audit-refusal';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// [ZONE-FARES] Fixed zone-to-zone fares had ONE writer: the platform seed,
// create-if-missing. There was no admin route, so the seeded 2,000 Georgetown
// Central ↔ South fare — which contradicts the owner's formula — could not be
// taken back on a running install, and no fare could be set or changed.
//
// Now: GET/POST/PUT/DELETE /api/v1/admin/zone-fares, founder-only on the
// default tenant, C5 platform pricing (a stated reason, a SECOND admin, the
// audit row inside the transaction), walled to the caller's tenant through
// BOTH zones (the fare table carries no tenant of its own) and to one market.
// A zone's own taxi per-km rate (POST/PUT /zones `taxiPerKm`) is audited the
// same way. And a change prices NEW quotes only: a ride requested before it
// keeps — and is paid — the fare it was booked at.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const PHONE_PREFIX = retainedPhonePrefix('25');
const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const TAG = `ZFA${RUN.toUpperCase()}`;
const TENANT_B = 'zone-fares-tenant-b';
const REASON = 'The owner set this fare on the 1 October call, ref ZF-1';
const box = (lng1: number, lat1: number, lng2: number, lat2: number) => ({ type: 'Polygon', coordinates: [[[lng1, lat1], [lng2, lat1], [lng2, lat2], [lng1, lat2], [lng1, lat1]]] });
// This suite's own zones, east of every seeded zone and every other suite's.
const ZA = box(-57.56, 6.60, -57.52, 6.64);
const ZB = box(-57.50, 6.60, -57.46, 6.64);
const ZT = box(-57.44, 6.60, -57.40, 6.64);
const ZPK = box(-57.38, 6.60, -57.34, 6.64);
const ZPK_ELSEWHERE = box(-57.38, 6.66, -57.34, 6.68);
const IN_A = { lat: 6.62, lng: -57.54 };
const IN_A_TOO = { lat: 6.63, lng: -57.53 };
const IN_B = { lat: 6.62, lng: -57.48 };
const IN_PK = { lat: 6.62, lng: -57.36 };
const OUTSIDE = { lat: 6.70, lng: -57.36 };

let app: FastifyInstance;
let seq = 0;
const zoneIds: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-fixture:zone-fares-admin');

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole, opts: { tenantId?: string; permissions?: string[]; customer?: boolean } = {}): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Zone', lastName: `Fare${seq}`, roles, activeRole, status: 'ACTIVE',
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      tenantId: opts.tenantId ?? DEFAULT_TENANT_ID,
      ...(opts.customer || roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
      ...(opts.permissions ? { admin: { create: { permissions: opts.permissions } } } : {}),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `zfa-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

async function zone(name: string, boundary: unknown, opts: { tenantId?: string; countryCode?: string; taxiPerKm?: number } = {}) {
  const z = await sys(() => app.prisma.zone.create({
    data: { name: `${TAG} ${name}`, boundary: boundary as never, tenantId: opts.tenantId ?? DEFAULT_TENANT_ID, countryCode: opts.countryCode ?? 'GY', taxiPerKm: opts.taxiPerKm ?? null },
  }));
  zoneIds.push(z.id);
  return z;
}

function call(token: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: method as never, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

/** The real two-person path: ask (202) → a second admin approves → re-issue. */
function twoPerson(token: string, method: string, url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  };
  return injectWithApproval(app, options);
}

const fareRow = (fromZoneId: string, toZoneId: string) => sys(() => app.prisma.zoneFare.findUnique({ where: { fromZoneId_toZoneId: { fromZoneId, toZoneId } } }));
const auditRows = (userId: string, entityId: string) => sys(() => app.prisma.auditLog.findMany({ where: { userId, entityId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
const inlineCount = async () => (await adminAuditCounter.get()).values.find((v) => v.labels['writer'] === 'inline' && v.labels['cls'] === 'C5')?.value ?? 0;
const quote = (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => new FareService(app.prisma).estimate(from, to, 'GY', DEFAULT_TENANT_ID);

let founder: Actor;
let zoneA: { id: string }; let zoneB: { id: string }; let zoneT: { id: string };
let bA: { id: string }; let bB: { id: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app, true);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
  await sys(() => app.prisma.zone.deleteMany({ where: { name: { startsWith: 'ZFA' } } }));
  await sys(() => app.prisma.tenant.upsert({ where: { id: TENANT_B }, update: {}, create: { id: TENANT_B, name: 'Zone fares B', slug: `zone-fares-b-${RUN}` } }));
  founder = await makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { permissions: ['*'] });
  zoneA = await zone('A', ZA);
  zoneB = await zone('B', ZB);
  zoneT = await zone('T, another market', ZT, { countryCode: 'TT' });
  bA = await zone('B-operator A', ZA, { tenantId: TENANT_B });
  bB = await zone('B-operator B', ZB, { tenantId: TENANT_B });
});

afterAll(async () => {
  await cleanupSecondApprovers(app);
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const driverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const orderIds = (await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { driverId: { in: driverIds } }] }, select: { id: true } })).map((o) => o.id);
    const kept = await retainedCohort(app.prisma, { orderIds });
    await app.prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...driverIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    await app.prisma.earning.deleteMany({ where: { orderId: { in: without(orderIds, kept.orderIds) } } });
    if (orderIds.length > 0) await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.supplyWatch.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: without(orderIds, kept.orderIds) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: without(driverIds, kept.driverIds) } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: without(ids, kept.userIds) } } });
    await purgeAuditLogs(app.prisma, { userId: { in: ids } }, 'test-cleanup:zone-fares-admin').catch(() => 0);
    await app.prisma.user.deleteMany({ where: { id: { in: without(ids, kept.userIds) } } });
    await retireKeptScaffolding(app.prisma, kept);
    await app.prisma.zone.deleteMany({ where: { OR: [{ id: { in: zoneIds } }, { name: { startsWith: TAG } }] } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } }).catch(() => {});
  });
  await app.close();
});

describe('[ZONE-FARES] who may set a fixed fare — the founder, on the default tenant, holding the capability', () => {
  const routes = (fareId: string): Array<[string, string, unknown]> => [
    ['GET', '/api/v1/admin/zone-fares', undefined],
    ['POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3000 }],
    ['PUT', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 9999 }],
    ['DELETE', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id }],
  ];
  let fixture: { id: string };
  beforeAll(async () => {
    // a real fare for the PUT/DELETE attempts to aim at
    fixture = await sys(() => app.prisma.zoneFare.create({ data: { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 2500 } }));
  });
  afterAll(async () => {
    await sys(() => app.prisma.zoneFare.deleteMany({ where: { id: fixture.id } }));
  });
  const unchanged = async () => {
    const row = await sys(() => app.prisma.zoneFare.findUnique({ where: { id: fixture.id } }));
    expect(Number(row?.fare), 'the fixture fare is unchanged and still there').toBe(2500);
  };

  it('nobody signed in: 401, and nothing changes', async () => {
    for (const [method, url, payload] of routes(fixture.id)) {
      expect((await call(null, method, url, payload)).statusCode, `${method} ${url}`).toBe(401);
    }
    await unchanged();
  });

  it('a customer: 403, and nothing changes', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    for (const [method, url, payload] of routes(fixture.id)) {
      expect((await call(customer.token, method, url, payload, { 'x-swift-reason': REASON })).statusCode, `${method} ${url}`).toBe(403);
    }
    await unchanged();
  });

  it('an ADMIN who is not the founder: refused even with a second admin\'s approval, and nothing changes', async () => {
    const admin = await makeUser(['ADMIN', 'CUSTOMER'], 'ADMIN', { permissions: ['*'] });
    for (const [method, url, payload] of routes(fixture.id)) {
      const res = await twoPerson(admin.token, method, url, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      expect(res.json().error.message).toBe('Founder access required');
    }
    await unchanged();
    expect(await sys(() => app.prisma.zoneFare.count({ where: { fromZoneId: zoneA.id, toZoneId: zoneB.id } }))).toBe(1);
  });

  it('the founder of ANOTHER operator: refused (platform pricing is the default tenant\'s), and nothing changes', async () => {
    const foreign = await makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { tenantId: TENANT_B, permissions: ['*'] });
    for (const [method, url, payload] of routes(fixture.id)) {
      const res = await twoPerson(foreign.token, method, url, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(403);
      expect(res.json().error.message).toBe('Platform controls require the default tenant');
    }
    await unchanged();
  });

  it('a founder whose grant does not hold the zone-fare capability: refused by the capability engine, and nothing changes', async () => {
    const scoped = await makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { permissions: ['platform.zone.*', 'dashboard.read'] });
    for (const [method, url, payload] of routes(fixture.id)) {
      const res = await call(scoped.token, method, url, payload, { 'x-swift-reason': REASON });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toMatch(/platform\.zonefare\.(read|write) capability/);
    }
    await unchanged();
  });
});

describe('[ZONE-FARES] one admin alone cannot price a pair', () => {
  it('the ask is queued for a second admin (202) with the pair and the price on it; nothing is written; self-approval is refused', async () => {
    const ask = await call(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3000 }, { 'x-swift-reason': REASON });
    expect(ask.statusCode, ask.body).toBe(202);
    expect(ask.json().error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = ask.json().error.details.approvalId as string;
    const approval = await sys(() => app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id: approvalId } }));
    expect(approval).toMatchObject({ action: 'POST /zone-fares', cls: 'C5', capability: 'platform.zonefare.write', status: 'PENDING', reason: REASON });
    expect((approval as unknown as { bodySnapshot: { body: unknown } }).bodySnapshot.body).toEqual({ fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3000 });
    expect(await fareRow(zoneA.id, zoneB.id)).toBeNull();
    const self = await call(founder.token, 'POST', `/api/v1/admin/approvals/${approvalId}/decide`, { approve: true, note: 'approving my own ask here' }, { 'x-swift-reason': REASON });
    expect(self.statusCode).toBe(403);
    expect(await fareRow(zoneA.id, zoneB.id)).toBeNull();
  });
});

describe('[ZONE-FARES] create, change and delete — each with its audit row, written inside its own transaction', () => {
  let fareId = '';

  it('create: the pair is priced for NEW quotes, the row names who set it, and the trail names the row, the pair, the price and why', async () => {
    const before = await inlineCount();
    const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3000 });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    fareId = data.id;
    expect(data).toMatchObject({ fromZoneId: zoneA.id, toZoneId: zoneB.id, fromZoneName: `${TAG} A`, toZoneName: `${TAG} B`, countryCode: 'GY', fare: 3000, zonesActive: true });
    const row = await fareRow(zoneA.id, zoneB.id);
    expect({ id: row?.id, fare: Number(row?.fare), updatedBy: row?.updatedBy }).toEqual({ id: fareId, fare: 3000, updatedBy: founder.userId });
    expect(await quote(IN_A, IN_B)).toMatchObject({ fare: 3000, source: 'zone_table', fromZoneId: zoneA.id, toZoneId: zoneB.id });

    const trail = await auditRows(founder.userId, fareId);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: 'ADMIN POST /api/v1/admin/zone-fares', entity: 'zone-fares', entityId: fareId });
    expect(trail[0]!.changes).toMatchObject({ fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3000, reason: REASON, subject: 'no-single-row' });
    expect(await inlineCount()).toBe(before + 1);
  });

  it('the list names each pair by its zones, with the fare as a number, beside every zone of the operator and its own per-km rate', async () => {
    const res = await call(founder.token, 'GET', '/api/v1/admin/zone-fares');
    expect(res.statusCode, res.body).toBe(200);
    const { fares, zones } = res.json().data as { fares: Array<Record<string, unknown>>; zones: Array<Record<string, unknown>> };
    expect(fares.find((f) => f['id'] === fareId)).toMatchObject({ fromZoneName: `${TAG} A`, toZoneName: `${TAG} B`, fare: 3000 });
    expect(zones.find((z) => z['id'] === zoneA.id)).toMatchObject({ name: `${TAG} A`, countryCode: 'GY', taxiPerKm: null, isActive: true });
    // the operator's own zones only
    expect(zones.some((z) => z['id'] === bA.id)).toBe(false);
  });

  it('a second fare for the same pair is refused, naming the one to change', async () => {
    const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3100 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ZONE_FARE_EXISTS', details: { id: fareId } });
    expect(Number((await fareRow(zoneA.id, zoneB.id))?.fare)).toBe(3000);
  });

  it('change: the new fare prices the next quote, and the trail records the fare before and after', async () => {
    const res = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3500 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: fareId, fare: 3500 });
    expect((await quote(IN_A, IN_B)).fare).toBe(3500);
    const trail = await auditRows(founder.userId, fareId);
    const change = trail.find((r) => r.action === 'ADMIN PUT /api/v1/admin/zone-fares/:id')!;
    expect(change).toMatchObject({ entity: 'zone-fares', entityId: fareId });
    const changes = change.changes as { before: string | null; after: string | null; changed: Record<string, { from: unknown; to: unknown }>; reason: string };
    expect(changes.reason).toBe(REASON);
    expect(changes.changed['fare']).toEqual({ from: '3000', to: '3500' });
    expect(changes.before).toBeTruthy();
    expect(changes.after).toBeTruthy();
    expect(changes.before).not.toBe(changes.after);
  });

  it('a change aimed at the wrong pair is refused and changes nothing', async () => {
    const res = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneB.id, toZoneId: zoneA.id, fare: 100 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ZONE_FARE_PAIR_MISMATCH');
    expect(Number((await fareRow(zoneA.id, zoneB.id))?.fare)).toBe(3500);
  });

  it('delete: the pair is gone, the next quote is the formula, and the trail records what was removed', async () => {
    const wrong = await twoPerson(founder.token, 'DELETE', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneB.id, toZoneId: zoneA.id });
    expect(wrong.statusCode, wrong.body).toBe(409);
    expect(await fareRow(zoneA.id, zoneB.id)).not.toBeNull();

    const res = await twoPerson(founder.token, 'DELETE', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual({ id: fareId, fromZoneId: zoneA.id, toZoneId: zoneB.id, deleted: true });
    expect(await fareRow(zoneA.id, zoneB.id)).toBeNull();
    expect((await quote(IN_A, IN_B)).source).toBe('formula');
    const removal = (await auditRows(founder.userId, fareId)).find((r) => r.action === 'ADMIN DELETE /api/v1/admin/zone-fares/:id')!;
    const changes = removal.changes as { before: string | null; after: string | null; changed: Record<string, { from: unknown; to: unknown }> };
    expect(changes.before).toBeTruthy();
    expect(changes.after).toBeNull();
    expect(changes.changed['fare']).toEqual({ from: '3500', to: null });

    const again = await twoPerson(founder.token, 'DELETE', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id });
    expect(again.statusCode).toBe(404);
  });

  it('a same-zone pair is a flat fare inside the zone — the engine has always priced one, so the admin may set one', async () => {
    const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneA.id, fare: 1500 });
    expect(res.statusCode, res.body).toBe(200);
    expect(await quote(IN_A, IN_A_TOO)).toMatchObject({ fare: 1500, source: 'zone_table' });
    const gone = await twoPerson(founder.token, 'DELETE', `/api/v1/admin/zone-fares/${res.json().data.id}`, { fromZoneId: zoneA.id, toZoneId: zoneA.id });
    expect(gone.statusCode, gone.body).toBe(200);
  });

  it('the fare is a whole amount between 100 and 1,000,000, both zones named — anything else is refused and nothing is written', async () => {
    const bodies: unknown[] = [
      { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 99 },
      { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 0 },
      { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: -2000 },
      { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 1500.5 },
      { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 1_000_001 },
      { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: '3000' },
      { fromZoneId: zoneA.id, toZoneId: zoneB.id },
      { fromZoneId: zoneA.id, fare: 3000 },
      { fromZoneId: '', toZoneId: zoneB.id, fare: 3000 },
    ];
    for (const body of bodies) {
      const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(await fareRow(zoneA.id, zoneB.id)).toBeNull();
    // the bounds themselves are accepted
    for (const fare of [100, 1_000_000]) {
      const ok = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneB.id, toZoneId: zoneA.id, fare });
      expect(ok.statusCode, ok.body).toBe(200);
      await sys(() => app.prisma.zoneFare.deleteMany({ where: { fromZoneId: zoneB.id, toZoneId: zoneA.id } }));
    }
  });
});

describe('[ZONE-FARES] the walls: another operator\'s zones and fares, and another market', () => {
  it('a pair naming another operator\'s zone reads as a zone that does not exist, from either end', async () => {
    for (const body of [{ fromZoneId: bA.id, toZoneId: zoneB.id, fare: 3000 }, { fromZoneId: zoneA.id, toZoneId: bB.id, fare: 3000 }, { fromZoneId: bA.id, toZoneId: bB.id, fare: 3000 }]) {
      const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(404);
    }
    expect(await sys(() => app.prisma.zoneFare.count({ where: { OR: [{ fromZoneId: { in: [bA.id, bB.id] } }, { toZoneId: { in: [bA.id, bB.id] } }] } }))).toBe(0);
  });

  it('another operator\'s fare is not listed, and cannot be changed or deleted by id', async () => {
    const theirs = await sys(() => app.prisma.zoneFare.create({ data: { fromZoneId: bA.id, toZoneId: bB.id, fare: 7777 } }));
    try {
      const list = await call(founder.token, 'GET', '/api/v1/admin/zone-fares');
      expect((list.json().data.fares as Array<{ id: string }>).some((f) => f.id === theirs.id)).toBe(false);
      const change = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zone-fares/${theirs.id}`, { fromZoneId: bA.id, toZoneId: bB.id, fare: 100 });
      expect(change.statusCode, change.body).toBe(404);
      const remove = await twoPerson(founder.token, 'DELETE', `/api/v1/admin/zone-fares/${theirs.id}`, { fromZoneId: bA.id, toZoneId: bB.id });
      expect(remove.statusCode, remove.body).toBe(404);
      const after = await sys(() => app.prisma.zoneFare.findUnique({ where: { id: theirs.id } }));
      expect(Number(after?.fare)).toBe(7777);
    } finally {
      await sys(() => app.prisma.zoneFare.deleteMany({ where: { id: theirs.id } }));
    }
  });

  it('a pair across two markets could never price a trip, so it is refused', async () => {
    const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneT.id, fare: 3000 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'ZONE_FARE_MARKET_MISMATCH', details: { fromCountryCode: 'GY', toCountryCode: 'TT' } });
    expect(await fareRow(zoneA.id, zoneT.id)).toBeNull();
  });
});

describe('[ADM-002] a refused audit row takes the fare change down with it', () => {
  const NAME = refusalName('zfa');
  afterAll(async () => { await dropAuditRefusal(app, NAME); });

  it('create: the database refuses the audit row, so the fare is not created', async () => {
    await refuseAuditWhere(app, NAME, { actionLike: 'ADMIN POST /api/v1/admin/zone-fares%' });
    try {
      const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 4100 });
      expect(res.statusCode, 'a fare whose audit row was refused must not report success').not.toBe(200);
    } finally {
      await dropAuditRefusal(app, NAME);
    }
    expect(await fareRow(zoneA.id, zoneB.id)).toBeNull();
  });

  it('delete: the database refuses the audit row, so the fare stays', async () => {
    const row = await sys(() => app.prisma.zoneFare.create({ data: { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 4200 } }));
    await refuseAuditWhere(app, NAME, { entityId: row.id });
    try {
      const res = await twoPerson(founder.token, 'DELETE', `/api/v1/admin/zone-fares/${row.id}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id });
      expect(res.statusCode).not.toBe(200);
    } finally {
      await dropAuditRefusal(app, NAME);
    }
    expect(Number((await fareRow(zoneA.id, zoneB.id))?.fare)).toBe(4200);
    await sys(() => app.prisma.zoneFare.deleteMany({ where: { id: row.id } }));
  });
});

describe('[ZONE-FARES] a zone\'s own per-km rate, set and changed through the zone admin', () => {
  const slug = `zf-rated-${RUN}`;

  it('a zone is created with a per-km rate and, when asked, the stable id a seed would give it', async () => {
    const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zones', { id: slug, name: `${TAG} rated`, boundary: ZPK, taxiPerKm: 295 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ id: slug, taxiPerKm: 295, version: 1, tenantId: DEFAULT_TENANT_ID, countryCode: 'GY' });
    zoneIds.push(slug);
    const list = await call(founder.token, 'GET', '/api/v1/admin/zones');
    expect((list.json().data as Array<{ id: string; taxiPerKm: unknown }>).find((z) => z.id === slug)?.taxiPerKm).toBe(295);
    expect(await auditRows(founder.userId, slug)).toHaveLength(1);
  });

  it('an id already taken is refused by name, never as a raw constraint error', async () => {
    const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zones', { id: slug, name: `${TAG} twin`, boundary: ZPK_ELSEWHERE, taxiPerKm: 295 });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('ZONE_ID_TAKEN');
  });

  it('a rate is a whole positive amount up to 10,000 a kilometre, and an id is a lowercase slug — anything else is refused', async () => {
    for (const taxiPerKm of [0, -295, 295.5, 10_001, '295']) {
      const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zones', { name: `${TAG} bad rate`, boundary: ZPK_ELSEWHERE, taxiPerKm });
      expect(res.statusCode, String(taxiPerKm)).toBe(400);
    }
    for (const id of ['Has Space', 'UPPER-case', 'x', 'double--hyphen', '-leading', 'trailing-', 'a'.repeat(49)]) {
      const res = await twoPerson(founder.token, 'POST', '/api/v1/admin/zones', { id, name: `${TAG} bad id`, boundary: ZPK_ELSEWHERE });
      expect(res.statusCode, id).toBe(400);
    }
    expect(await sys(() => app.prisma.zone.count({ where: { name: { in: [`${TAG} bad rate`, `${TAG} bad id`] } } }))).toBe(0);
  });

  it('changing or clearing the rate is a new zone version with the rate before and after on the trail; a copy edit is not; the id never changes', async () => {
    const raise = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zones/${slug}`, { taxiPerKm: 400 });
    expect(raise.statusCode, raise.body).toBe(200);
    expect(raise.json().data).toMatchObject({ id: slug, taxiPerKm: 400, version: 2 });
    const change = (await auditRows(founder.userId, slug)).find((r) => r.action === 'ADMIN PUT /api/v1/admin/zones/:id')!;
    expect((change.changes as { changed: Record<string, unknown> }).changed['taxiPerKm']).toEqual({ from: '295', to: '400' });

    const copy = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zones/${slug}`, { description: 'Rated test zone', id: 'renamed-zone' });
    expect(copy.statusCode, copy.body).toBe(200);
    expect(copy.json().data).toMatchObject({ id: slug, version: 2, taxiPerKm: 400 });

    const clear = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zones/${slug}`, { taxiPerKm: null });
    expect(clear.statusCode, clear.body).toBe(200);
    expect(clear.json().data).toMatchObject({ taxiPerKm: null, version: 3 });

    const back = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zones/${slug}`, { taxiPerKm: 295 });
    expect(back.json().data).toMatchObject({ taxiPerKm: 295, version: 4 });
  });
});

describe('[ZONE-FARES] a change prices NEW quotes only — a requested ride keeps, and is paid, the fare it was booked at', () => {
  let gyRates: Awaited<ReturnType<typeof readTaxiRates>>['payload'];
  beforeAll(async () => {
    gyRates = (await readTaxiRates(app.prisma as never, 'GY')).payload;
  });

  async function makeDriverAt(point: { lat: number; lng: number }) {
    const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
    const driver = await sys(() => app.prisma.driver.create({
      data: {
        userId: u.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
        licensePlate: `ZF-${seq}`, driverLicenseUrl: 'storage://zf/dl.jpg', vehicleInsuranceUrl: 'storage://zf/ins.jpg',
        documentsVerified: true, isOnline: true, isAvailable: true, currentLat: point.lat, currentLng: point.lng,
        lastLocationUpdate: new Date(), locationSessionId: u.sessionId,
      },
    }));
    // [#1405] Taking work reads the driver's CURRENT documents: an approved,
    // unexpired hire-class insurance, as taxi.test.ts's online fixture holds.
    await sys(() => app.prisma.verificationDocument.create({ data: {
      userId: u.userId, role: 'MOVER', docType: 'vehicle_insurance', status: 'APPROVED',
      fileUrl: 'storage://synthetic/current-insurance', expiresAt: new Date(Date.now() + DAY),
      coverageClass: 'HIRE', hireClassConfirmed: true, plateCrossChecked: true,
    } }));
    await sys(() => currentTaxiSplitDocuments(app.prisma, u.userId));
    return { ...u, driverId: driver.id };
  }

  /** Request at the current price, let `change` move the price, then drive the
   *  ride to "fare collected". Returns the booked fare, the next quote, and the
   *  money that actually moved. */
  async function bookChangeAndRide(pickup: { lat: number; lng: number }, dropoff: { lat: number; lng: number }, change: () => Promise<void>) {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const driver = await makeDriverAt(pickup);
    const booked = await call(customer.token, 'POST', '/api/v1/rides/request', { pickup, dropoff, pickupAddress: `${TAG} pickup road`, dropoffAddress: `${TAG} dropoff road` });
    expect(booked.statusCode, booked.body).toBe(201);
    const ride = booked.json().data.ride as { id: string; fare: number; ridePin: string };

    await change();

    const next = await call(customer.token, 'POST', '/api/v1/rides/estimate', { pickup, dropoff });
    const nextFare = (next.json().data.tiers as Array<{ rideClass: string; fare: number }>).find((t) => t.rideClass === 'ECONOMY')!.fare;
    const steps: Array<[string, string, unknown]> = [
      ['POST', `/api/v1/driver/rides/${ride.id}/accept`, {}],
      ['PUT', `/api/v1/driver/rides/${ride.id}/en-route`, {}],
      ['PUT', `/api/v1/driver/rides/${ride.id}/arrived`, {}],
      ['PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, { pin: ride.ridePin }],
      ['PUT', `/api/v1/driver/rides/${ride.id}/start`, {}],
    ];
    for (const [method, url, payload] of steps) {
      const step = await call(driver.token, method, url, payload);
      expect(step.statusCode, `${method} ${url}: ${step.body}`).toBe(200);
      // nothing on the way re-prices the ride
      expect(Number((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } }))).taxiFareTotal), url).toBe(ride.fare);
    }
    const paid = await call(driver.token, 'POST', `/api/v1/driver/rides/${ride.id}/handover`, { outcome: 'paid', gps: dropoff }, { 'idempotency-key': `zf-${nanoid(10)}` });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().data.status).toBe('DELIVERED');
    const [order, earnings, notice] = await Promise.all([
      sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } })),
      sys(() => app.prisma.earning.findMany({ where: { orderId: ride.id } })),
      sys(() => app.prisma.notification.findFirst({ where: { userId: customer.userId, title: 'Ride Complete' } })),
    ]);
    return {
      booked: ride.fare,
      next: nextFare,
      order: { total: Number(order.totalAmount), fare: Number(order.taxiFareTotal), status: order.status },
      earnings: earnings.map((e) => ({ type: e.type, amount: Number(e.amount) })),
      notice: notice?.body ?? null,
    };
  }

  it('a fixed fare raised after booking: the ride is paid the booked fare; the next quote is the new one', async () => {
    const created = await twoPerson(founder.token, 'POST', '/api/v1/admin/zone-fares', { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 3000 });
    expect(created.statusCode, created.body).toBe(200);
    const fareId = created.json().data.id as string;
    try {
      const outcome = await bookChangeAndRide(IN_A, IN_B, async () => {
        const raised = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 4200 });
        expect(raised.statusCode, raised.body).toBe(200);
      });
      expect(outcome).toEqual({
        booked: 3000,
        next: 4200,
        order: { total: 3000, fare: 3000, status: 'DELIVERED' },
        earnings: [{ type: 'TAXI_FARE', amount: 3000 }],
        notice: 'You have arrived at your destination. Total fare: $3,000 GYD.',
      });
      // and deleting the fare after a booking does not reach back either
      const removed = await twoPerson(founder.token, 'DELETE', `/api/v1/admin/zone-fares/${fareId}`, { fromZoneId: zoneA.id, toZoneId: zoneB.id });
      expect(removed.statusCode, removed.body).toBe(200);
    } finally {
      // a failure above must not leave this pair behind for the suites after it
      await sys(() => app.prisma.zoneFare.deleteMany({ where: { id: fareId } }));
    }
  });

  it('a zone\'s per-km rate raised after booking: the ride is paid the booked fare; the next quote is priced at the new rate', async () => {
    const slug = `zf-rated-${RUN}`;
    const bookedAt = (await quote(IN_PK, OUTSIDE));
    expect(bookedAt.fare).toBe(formulaFare({ ...gyRates, perKm: 295 }, bookedAt.billableKm, bookedAt.durationMin));
    const outcome = await bookChangeAndRide(IN_PK, OUTSIDE, async () => {
      const raised = await twoPerson(founder.token, 'PUT', `/api/v1/admin/zones/${slug}`, { taxiPerKm: 900 });
      expect(raised.statusCode, raised.body).toBe(200);
    });
    const at900 = formulaFare({ ...gyRates, perKm: 900 }, bookedAt.billableKm, bookedAt.durationMin);
    expect(at900).toBeGreaterThan(bookedAt.fare);
    expect(outcome).toMatchObject({
      booked: bookedAt.fare,
      next: at900,
      order: { total: bookedAt.fare, fare: bookedAt.fare, status: 'DELIVERED' },
      earnings: [{ type: 'TAXI_FARE', amount: bookedAt.fare }],
    });
  });
});

describe('[ZONE-FARES] the staging path: ask → a second admin decides → the asker applies the STORED request', () => {
  /** What the console's approvals page does, and what the staging calls do. */
  async function throughApplyRoute(method: string, url: string, payload: unknown) {
    const approver = await makeUser(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', { permissions: ['*'] });
    const ask = await call(founder.token, method, url, payload, { 'x-swift-reason': REASON });
    expect(ask.statusCode, ask.body).toBe(202);
    const approvalId = ask.json().error.details.approvalId as string;
    const decided = await call(approver.token, 'POST', `/api/v1/admin/approvals/${approvalId}/decide`, { approve: true, note: 'Checked against the owner ruling' }, { 'x-swift-reason': REASON });
    expect(decided.statusCode, decided.body).toBe(200);
    const applied = await call(founder.token, 'POST', `/api/v1/admin/approvals/${approvalId}/apply`, {});
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json().data).toMatchObject({ id: approvalId, status: 'APPLIED' });
    return approvalId;
  }

  it('a DELETE with its pair in the body is replayed exactly: the fare is gone', async () => {
    const row = await sys(() => app.prisma.zoneFare.create({ data: { fromZoneId: zoneB.id, toZoneId: zoneA.id, fare: 2000 } }));
    await throughApplyRoute('DELETE', `/api/v1/admin/zone-fares/${row.id}`, { fromZoneId: zoneB.id, toZoneId: zoneA.id });
    expect(await fareRow(zoneB.id, zoneA.id)).toBeNull();
  });

  it('a zone with its seed id and its per-km rate is created exactly as asked', async () => {
    const slug = `zf-apply-${RUN}`;
    await throughApplyRoute('POST', '/api/v1/admin/zones', { id: slug, name: `${TAG} applied`, boundary: ZPK_ELSEWHERE, taxiPerKm: 295, countryCode: 'GY', priority: 0 });
    zoneIds.push(slug);
    const made = await sys(() => app.prisma.zone.findUniqueOrThrow({ where: { id: slug } }));
    expect({ id: made.id, perKm: Number(made.taxiPerKm), tenant: made.tenantId, country: made.countryCode }).toEqual({ id: slug, perKm: 295, tenant: DEFAULT_TENANT_ID, country: 'GY' });
  });
});

describe('[ZONE-FARES · Sol F1] another operator\'s fare is never READ — the tenant wall is in every query by id', () => {
  // A second app whose client records every query on the fare table: the
  // operation, its arguments, and what the database answered. The routes, the
  // approval replay and the audit snapshots all run through it.
  type Seen = { operation: string; args: Record<string, unknown>; result: unknown };
  const seen: Seen[] = [];
  let rec: FastifyInstance;
  let theirs: { id: string };

  const recordingClient = (scopedPrisma as unknown as { $extends: (e: unknown) => unknown }).$extends({
    name: 'zoneFareRecorder',
    query: {
      zoneFare: {
        async $allOperations({ operation, args, query }: { operation: string; args: Record<string, unknown>; query: (a: unknown) => Promise<unknown> }) {
          const result = await query(args);
          seen.push({ operation, args: JSON.parse(JSON.stringify(args ?? {})), result: JSON.parse(JSON.stringify(result ?? null)) });
          return result;
        },
      },
    },
  });

  beforeAll(async () => {
    rec = Fastify({ logger: false });
    registerErrorHandler(rec);
    registerEmptyJsonBodyParser(rec);
    rec.addHook('onRequest', async () => { beginRequestTenantContext(); });
    await rec.register(fp(async (instance: FastifyInstance) => { instance.decorate('prisma', recordingClient as never); }));
    await rec.register(redisPlugin);
    await rec.register(authPlugin);
    await rec.register(socketPlugin);
    await rec.register(adminRoutes, { prefix: '/api/v1/admin' });
    await rec.ready();
    theirs = await sys(() => app.prisma.zoneFare.create({ data: { fromZoneId: bA.id, toZoneId: bB.id, fare: 7777 } }));
  });
  afterAll(async () => {
    await cleanupSecondApprovers(rec);
    await sys(() => app.prisma.zoneFare.deleteMany({ where: { id: theirs.id } }));
    await rec.close();
  });

  const byId = (id: string) => seen.filter((q) => JSON.stringify(q.args).includes(id));
  const walledOn = (q: Seen) => {
    const where = (q.args['where'] ?? {}) as Record<string, unknown>;
    return JSON.stringify(where['fromZone']) === JSON.stringify({ tenantId: DEFAULT_TENANT_ID })
      && JSON.stringify(where['toZone']) === JSON.stringify({ tenantId: DEFAULT_TENANT_ID });
  };

  it('change and delete of another operator\'s fare by id: every query that names it carries BOTH zones\' tenant, and none returns it', async () => {
    seen.length = 0;
    const via = (method: string, payload: unknown) => injectWithApproval(rec, {
      method: method as never, url: `/api/v1/admin/zone-fares/${theirs.id}`,
      headers: { authorization: `Bearer ${founder.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
      payload: payload as Record<string, unknown>,
    });
    expect((await via('PUT', { fromZoneId: bA.id, toZoneId: bB.id, fare: 100 })).statusCode).toBe(404);
    expect((await via('DELETE', { fromZoneId: bA.id, toZoneId: bB.id })).statusCode).toBe(404);
    const named = byId(theirs.id);
    // the lookup and the audit snapshot, for both routes, at the least
    expect(named.length, JSON.stringify(seen.map((q) => q.operation))).toBeGreaterThanOrEqual(4);
    for (const q of named) {
      expect(walledOn(q), `${q.operation} ${JSON.stringify(q.args)}`).toBe(true);
      expect(JSON.stringify(q.result), `${q.operation} returned the foreign fare`).not.toContain(theirs.id);
    }
    expect(Number((await sys(() => app.prisma.zoneFare.findUniqueOrThrow({ where: { id: theirs.id } }))).fare)).toBe(7777);
  });

  it('the caller\'s own fare: the lookup, the snapshot and the mutation selector all carry the wall, and the change lands', async () => {
    const mine = await sys(() => app.prisma.zoneFare.create({ data: { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 2600 } }));
    try {
      seen.length = 0;
      const res = await injectWithApproval(rec, {
        method: 'PUT', url: `/api/v1/admin/zone-fares/${mine.id}`,
        headers: { authorization: `Bearer ${founder.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
        payload: { fromZoneId: zoneA.id, toZoneId: zoneB.id, fare: 2700 },
      });
      expect(res.statusCode, res.body).toBe(200);
      const named = byId(mine.id);
      expect(named.map((q) => q.operation)).toContain('update');
      expect(named.filter((q) => q.operation === 'findUnique').length).toBeGreaterThanOrEqual(2); // lookup + before/after snapshots
      for (const q of named) expect(walledOn(q), `${q.operation} ${JSON.stringify(q.args)}`).toBe(true);
    } finally {
      await sys(() => app.prisma.zoneFare.deleteMany({ where: { id: mine.id } }));
    }
  });

  it('the caller\'s own fare deleted: the delete selector carries the wall too, and the row is gone', async () => {
    const mine = await sys(() => app.prisma.zoneFare.create({ data: { fromZoneId: zoneB.id, toZoneId: zoneA.id, fare: 2600 } }));
    try {
      seen.length = 0;
      const res = await injectWithApproval(rec, {
        method: 'DELETE', url: `/api/v1/admin/zone-fares/${mine.id}`,
        headers: { authorization: `Bearer ${founder.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
        payload: { fromZoneId: zoneB.id, toZoneId: zoneA.id },
      });
      expect(res.statusCode, res.body).toBe(200);
      const named = byId(mine.id);
      expect(named.map((q) => q.operation)).toContain('delete');
      for (const q of named) expect(walledOn(q), `${q.operation} ${JSON.stringify(q.args)}`).toBe(true);
      expect(await fareRow(zoneB.id, zoneA.id)).toBeNull();
    } finally {
      await sys(() => app.prisma.zoneFare.deleteMany({ where: { id: mine.id } }));
    }
  });

  it('the audit snapshot of a parent-walled entity reads nothing when no tenant is bound, and never another operator\'s row', async () => {
    const entity = ADMIN_ROUTE_AUTHORITY['PUT /zone-fares/:id']!.entity!;
    expect(entity.tenantVia).toEqual(['fromZone', 'toZone']);
    expect(tenantPredicateOf(entity, null)).toBeNull();
    expect(tenantPredicateOf(entity, 'swift-default')).toEqual({ fromZone: { tenantId: 'swift-default' }, toZone: { tenantId: 'swift-default' } });
    expect(tenantPredicateOf({}, null)).toEqual({});
    const before = (await adminAuditSnapshotCounter.get()).values.find((v) => v.labels['outcome'] === 'no_tenant' && v.labels['model'] === 'zoneFare')?.value ?? 0;
    seen.length = 0;
    expect(await runWithoutTenant(() => snapshot(recordingClient as never, entity, theirs.id))).toMatchObject({ exists: false });
    expect(byId(theirs.id), 'with no tenant bound nothing is read').toEqual([]);
    const after = (await adminAuditSnapshotCounter.get()).values.find((v) => v.labels['outcome'] === 'no_tenant' && v.labels['model'] === 'zoneFare')?.value ?? 0;
    expect(after).toBe(before + 1);
  });
});
