import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { loginWithOtp } from './helpers/otp';
import { FareService } from '../modules/rides/fare.service';
import { pickZone, scanFareZones, fareZoneTableKilled, DEFAULT_TENANT_ID } from '../modules/rides/fare-zones';
import { polygonArea, polygonsOverlap } from '../utils/geo';
import { fareZoneCounter, fareZoneGauge } from '../plugins/observability';
import { runWithoutTenant } from '../plugins/tenant-context';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [M-34] Fare zones are global and ambiguous across markets.
//
// The register's red test: two tenants / two countries with overlapping
// polygons and explicit precedence. A GY trip for the default operator prices
// by ITS zone; the same coordinates for another operator price by that
// operator's zone; the same coordinates in another country price by that
// country's zone and currency. Inside a market the highest priority wins;
// among equals the smallest polygon, deterministically, and the overlap is
// reported. The admin refuses a new equal-priority overlap; a boundary change
// is a new version; the kill switch prices every ride by the formula.
// ---------------------------------------------------------------------------

// All east of the seeded Georgetown zones (lng -58.18..-58.13), so nothing
// here can touch the taxi suites' fixed fare.
const box = (lng1: number, lat1: number, lng2: number, lat2: number) => ({ type: 'Polygon', coordinates: [[[lng1, lat1], [lng2, lat1], [lng2, lat2], [lng1, lat2], [lng1, lat1]]] });
const WIDE = box(-58.05, 6.70, -57.95, 6.90);
const CORE = box(-58.02, 6.79, -57.99, 6.82);
const CORE_BIGGER = box(-58.03, 6.78, -57.98, 6.83);
const IN_CORE = { lat: 6.80, lng: -58.00 };
const IN_WIDE_ONLY = { lat: 6.72, lng: -58.03 };
const TENANT_B = 'zones-tenant-b';
const TAG = `FZ${nanoid(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

let app: FastifyInstance;
let adminToken: string;
let otherCountry: { code: string; currencyCode: string };
const zoneIds: string[] = [];

// Fixture writes run outside any tenant context: a request's tenant binding
// (an admin inject) can outlive the request in this async flow, and the
// scoped zone model would then stamp or filter by the default tenant.
async function zone(name: string, boundary: unknown, opts: { tenantId?: string; countryCode?: string; priority?: number; isActive?: boolean } = {}) {
  const z = await runWithoutTenant(() => app.prisma.zone.create({ data: { name: `${TAG} ${name}`, boundary: boundary as never, tenantId: opts.tenantId ?? DEFAULT_TENANT_ID, countryCode: opts.countryCode ?? 'GY', priority: opts.priority ?? 0, isActive: opts.isActive ?? true } }));
  zoneIds.push(z.id);
  return z;
}
async function fare(fromZoneId: string, toZoneId: string, amount: number) {
  await runWithoutTenant(() => app.prisma.zoneFare.create({ data: { fromZoneId, toZoneId, fare: amount } }));
}
const svc = () => new FareService(app.prisma);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  // orphans from an interrupted run
  await runWithoutTenant(() => app.prisma.zone.deleteMany({ where: { name: { startsWith: 'FZ' } } }));
  await app.prisma.tenant.upsert({ where: { id: TENANT_B }, update: {}, create: { id: TENANT_B, name: 'Zones B', slug: `zones-b-${nanoid(5)}` } });
  const cfg = await app.prisma.countryConfig.findFirst({ where: { code: { not: 'GY' } }, select: { code: true, currencyCode: true } });
  if (!cfg) throw new Error('the suite needs a second CountryConfig — the seed plants the Caribbean markets');
  otherCountry = cfg;
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.zone.deleteMany({ where: { name: { startsWith: 'FZ' } } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
  await app.close();
});

describe('the law (pure)', () => {
  it('precedence: the highest priority, then the smallest polygon, then the id — the same answer every time; equals are flagged', () => {
    const a = { id: 'a', name: 'a', boundary: WIDE, priority: 0, version: 1 };
    const b = { id: 'b', name: 'b', boundary: CORE, priority: 0, version: 1 };
    const c = { id: 'c', name: 'c', boundary: CORE_BIGGER, priority: 2, version: 1 };
    expect(pickZone([a, b, c]).zone?.id).toBe('c');
    expect(pickZone([a, b])).toMatchObject({ zone: { id: 'b' }, ambiguous: true, contenders: 2 });
    expect(pickZone([b, a]).zone?.id).toBe('b');
    expect(pickZone([{ ...a, id: 'z' }, { ...a, id: 'y' }]).zone?.id).toBe('y');
    expect(pickZone([])).toEqual({ zone: null, ambiguous: false, contenders: 0 });
    expect(pickZone([a]).ambiguous).toBe(false);
  });
  it('overlap and area: disjoint boxes do not overlap; a contained box, a crossing box and a shared edge do', () => {
    expect(polygonsOverlap(WIDE, box(-57.90, 6.70, -57.80, 6.90))).toBe(false);
    expect(polygonsOverlap(WIDE, CORE)).toBe(true);
    expect(polygonsOverlap(CORE, WIDE)).toBe(true);
    expect(polygonsOverlap(CORE, box(-58.00, 6.80, -57.90, 6.85))).toBe(true);
    expect(polygonsOverlap(box(0, 0, 1, 1), box(1, 0, 2, 1))).toBe(true);
    expect(polygonsOverlap(box(0, 0, 1, 1), box(1.001, 0, 2, 1))).toBe(false);
    expect(polygonArea(CORE)).toBeLessThan(polygonArea(WIDE));
    expect(polygonArea({ type: 'Point' })).toBe(0);
    expect(polygonsOverlap({ type: 'Point' }, CORE)).toBe(false);
  });
  it('the kill switch is read from the environment', () => {
    expect(fareZoneTableKilled({})).toBe(false);
    expect(fareZoneTableKilled({ FARE_ZONE_TABLE_KILL: '1' })).toBe(true);
  });
});

describe('the register’s red test: two tenants, two countries, overlapping polygons, explicit precedence', () => {
  let wide: { id: string }; let core: { id: string }; let bCore: { id: string }; let xCore: { id: string };
  beforeAll(async () => {
    wide = await zone('GY wide', WIDE, { priority: 0 });
    core = await zone('GY core', CORE, { priority: 1 });
    bCore = await zone('B core', CORE, { tenantId: TENANT_B, priority: 0 });
    xCore = await zone('X core', CORE, { countryCode: otherCountry.code, priority: 0 });
    await fare(core.id, core.id, 1500);
    await fare(wide.id, wide.id, 900);
    await fare(bCore.id, bCore.id, 7777);
    await fare(xCore.id, xCore.id, 5555);
  });
  it('the default operator in GY: the higher-priority core zone prices the trip, and the estimate names the zone versions', async () => {
    const est = await svc().estimate(IN_CORE, IN_CORE, 'GY', DEFAULT_TENANT_ID);
    expect(est).toMatchObject({ fare: 1500, source: 'zone_table', fromZoneId: core.id, toZoneId: core.id, fromZoneVersion: 1, toZoneVersion: 1, currencyCode: 'GYD' });
    const wideOnly = await svc().estimate(IN_WIDE_ONLY, IN_WIDE_ONLY, 'GY', DEFAULT_TENANT_ID);
    expect(wideOnly).toMatchObject({ fare: 900, source: 'zone_table', fromZoneId: wide.id });
    // core → wide-only has no table row: the formula, with both zones still named
    const mixed = await svc().estimate(IN_CORE, IN_WIDE_ONLY, 'GY', DEFAULT_TENANT_ID);
    expect(mixed.source).toBe('formula');
    expect(mixed.fromZoneId).toBe(core.id);
    expect(mixed.toZoneId).toBe(wide.id);
  });
  it("another operator's identical polygon prices ITS trips — never the default operator's", async () => {
    const est = await runWithoutTenant(() => svc().estimate(IN_CORE, IN_CORE, 'GY', TENANT_B));
    expect(est).toMatchObject({ fare: 7777, source: 'zone_table', fromZoneId: bCore.id });
    // and the default operator never sees B's zone
    const mine = await svc().estimate(IN_CORE, IN_CORE, 'GY', DEFAULT_TENANT_ID);
    expect(mine.fromZoneId).toBe(core.id);
  });
  it("another country's identical polygon prices in that country — its fare, its currency; the default tenant's default-tenant argument is the same market law", async () => {
    const est = await svc().estimate(IN_CORE, IN_CORE, otherCountry.code);
    expect(est).toMatchObject({ fare: 5555, source: 'zone_table', fromZoneId: xCore.id, currencyCode: otherCountry.currencyCode });
  });
  it('equal-priority overlap inside a market: the smaller polygon wins deterministically, the pick is counted ambiguous, and the scan reports the pair', async () => {
    const before = (await fareZoneCounter.get()).values.find((v) => v.labels['event'] === 'ambiguous')?.value ?? 0;
    const bigger = await zone('GY core bigger', CORE_BIGGER, { priority: 1 });
    await fare(bigger.id, bigger.id, 4444);
    for (let i = 0; i < 5; i++) {
      const est = await svc().estimate(IN_CORE, IN_CORE, 'GY', DEFAULT_TENANT_ID);
      expect(est.fare).toBe(1500); // the smaller core, every time
      expect(est.fromZoneId).toBe(core.id);
    }
    const after = (await fareZoneCounter.get()).values.find((v) => v.labels['event'] === 'ambiguous')?.value ?? 0;
    expect(after).toBeGreaterThanOrEqual(before + 10);
    const scan = await scanFareZones(app.prisma);
    const pair = scan.ambiguousPairs.find((p) => [p.a, p.b].includes(core.id) && [p.a, p.b].includes(bigger.id));
    expect(pair).toMatchObject({ tenantId: DEFAULT_TENANT_ID, countryCode: 'GY', priority: 1 });
    expect((await fareZoneGauge.get()).values.find((v) => v.labels['check'] === 'ambiguous_pairs')?.value).toBe(scan.ambiguousPairs.length);
    await app.prisma.zone.update({ where: { id: bigger.id }, data: { isActive: false } });
    expect((await scanFareZones(app.prisma)).ambiguousPairs.some((p) => [p.a, p.b].includes(bigger.id))).toBe(false);
  });
  it('the admin refuses a new zone that overlaps a peer at the same priority; a different priority is accepted; a boundary change is a new version, a copy change is not', async () => {
    const headers = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
    const clash = await injectWithApproval(app, { method: 'POST', url: '/api/v1/admin/zones', headers: { ...headers, 'x-swift-reason': TEST_ADMIN_REASON }, payload: { name: `${TAG} clash`, boundary: CORE_BIGGER, priority: 1 } });
    expect(clash.statusCode, clash.body).toBe(409);
    expect(clash.json().error.code).toBe('ZONE_OVERLAP');
    expect(clash.json().error.message).toContain('GY core');
    const ok = await injectWithApproval(app, { method: 'POST', url: '/api/v1/admin/zones', headers: { ...headers, 'x-swift-reason': TEST_ADMIN_REASON }, payload: { name: `${TAG} above`, boundary: CORE_BIGGER, priority: 3, countryCode: 'gy' } });
    expect(ok.statusCode, ok.body).toBe(200);
    const created = ok.json().data; zoneIds.push(created.id);
    expect(created).toMatchObject({ tenantId: DEFAULT_TENANT_ID, countryCode: 'GY', priority: 3, version: 1 });
    // it now outranks the core zone for the same point
    const est = await svc().estimate(IN_CORE, IN_CORE, 'GY', DEFAULT_TENANT_ID);
    expect(est.fromZoneId).toBe(created.id);
    const reworded = await injectWithApproval(app, { method: 'PUT', url: `/api/v1/admin/zones/${created.id}`, headers: { ...headers, 'x-swift-reason': TEST_ADMIN_REASON }, payload: { description: 'reworded' } });
    expect(reworded.json().data.version).toBe(1);
    const redrawn = await injectWithApproval(app, { method: 'PUT', url: `/api/v1/admin/zones/${created.id}`, headers: { ...headers, 'x-swift-reason': TEST_ADMIN_REASON }, payload: { boundary: box(-58.04, 6.77, -57.97, 6.84) } });
    expect(redrawn.statusCode, redrawn.body).toBe(200);
    expect(redrawn.json().data.version).toBe(2);
    // moving it onto the core zone's priority is refused as the merged record
    const collide = await injectWithApproval(app, { method: 'PUT', url: `/api/v1/admin/zones/${created.id}`, headers: { ...headers, 'x-swift-reason': TEST_ADMIN_REASON }, payload: { priority: 1 } });
    expect(collide.statusCode).toBe(409);
    await app.prisma.zone.update({ where: { id: created.id }, data: { isActive: false } });
  });
  it('the kill switch: the table is ignored and every ride prices by the formula', async () => {
    process.env['FARE_ZONE_TABLE_KILL'] = '1';
    try {
      const est = await svc().estimate(IN_CORE, IN_CORE, 'GY', DEFAULT_TENANT_ID);
      expect(est.source).toBe('formula');
      expect(est.fromZoneId).toBeUndefined();
      expect((await fareZoneCounter.get()).values.find((v) => v.labels['event'] === 'killed')?.value ?? 0).toBeGreaterThan(0);
    } finally {
      delete process.env['FARE_ZONE_TABLE_KILL'];
    }
  });
});

describe('the call sites carry the market (source pins)', () => {
  const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('the estimate route and the ride request pass the tenant, and the fare service no longer reads every zone', () => {
    expect(src('modules/rides/rides.routes.ts')).toContain('fareService.estimateTiers(body.pickup, body.dropoff, user.countryCode, user.tenantId)');
    expect(src('modules/rides/rides.service.ts')).toContain('fareService.estimateTiers(body.pickup, body.dropoff, user.countryCode, orderTenantId)');
    const fare = src('modules/rides/fare.service.ts');
    expect(fare).toContain('resolveFareZones(this.prisma, { tenantId, countryCode }, pickup, dropoff)');
    expect(fare).not.toContain("zone.findMany({ where: { isActive: true } })");
  });
});
