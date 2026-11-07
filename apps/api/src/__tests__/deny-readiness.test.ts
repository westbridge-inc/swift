/**
 * [STA-1 4.1 / DL-7] Deny-readiness — every public GET survives
 * TENANT_UNSCOPED_ACCESS=deny.
 *
 * assertTenantWall requires `deny` in production wherever the database wall
 * actually binds — at any tenant count, one included (REPORT-111 P0.3).
 * Under deny, an unauthenticated GET that touches a tenant model without
 * binding a tenant is a 500 (TENANT_CONTEXT_REQUIRED) — measured on /home
 * before the public-browse hook. This suite builds the whole app, calls every
 * GET route anonymously under deny, and RATCHETS the set that fails that way:
 * it must equal the checked-in register, which only shrinks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { nanoid } from 'nanoid';
import { buildApp } from '../app';
import { CATEGORY_DISCOVERY_FLAG, resetDiscoveryCacheForTests } from '../modules/discovery/discovery.routes';
import { resolvePublicMarketTenant } from '../modules/search/search-scope';
import { runWithTenant } from '../plugins/tenant-context';

/** Public GETs known to reach a tenant model unbound under deny. Fix, then remove. */
export const DENY_UNREADY_GETS: readonly string[] = [];

let app: FastifyInstance;
const routes: RouteOptions[] = [];
const priorPolicy = process.env['TENANT_UNSCOPED_ACCESS'];
const priorRunWorkers = process.env['RUN_WORKERS'];

// This file's fixture block (+5920863nnn): the one signed-in customer below.
const PHONE_PREFIX = '+5920863';
let publicTenantId = '';
let customer: { userId: string; token: string } | null = null;
/** The rail flag as this file found it — restored afterwards. */
let priorRailFlag: { value: unknown } | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  // This suite needs the real queue producers/routes but never consumers.
  // Letting buildApp boot workers schedules repeatables that app.close() does
  // not own, leaking them into whichever test runs next on this Redis target.
  process.env['RUN_WORKERS'] = '0';
  app = await buildApp({ onRoute: (r) => { routes.push(r); } });
  await app.ready();
  // [Q12-B] The category rail is ON for the whole census, stated here: with
  // the flag OFF its route answers before it touches a tenant model, so a
  // census that inherited whatever flag another suite left behind proved
  // nothing about the rail (discovery-rail.test.ts deletes it; the demo seed
  // turns it on).
  priorRailFlag = await app.prisma.platformConfig.findUnique({ where: { key: CATEGORY_DISCOVERY_FLAG }, select: { value: true } });
  await app.prisma.platformConfig.upsert({
    where: { key: CATEGORY_DISCOVERY_FLAG },
    create: { key: CATEGORY_DISCOVERY_FLAG, value: true },
    update: { value: true },
  });
  resetDiscoveryCacheForTests();
  // A signed-in customer of the public catalogue's tenant, for the sweep.
  publicTenantId = await resolvePublicMarketTenant(app);
  customer = await runWithTenant(publicTenantId, async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: `${PHONE_PREFIX}${String(Date.now() % 1000).padStart(3, '0')}`, firstName: 'Deny', lastName: 'Ready',
        roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} },
      },
    });
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'deny-readiness', deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return { userId: user.id, token };
  });
});

afterAll(async () => {
  if (customer) {
    const userId = customer.userId;
    await runWithTenant(publicTenantId, async () => {
      await app.prisma.session.deleteMany({ where: { userId } });
      await app.prisma.customer.deleteMany({ where: { userId } });
      await app.prisma.user.deleteMany({ where: { id: userId } });
    });
  }
  if (priorRailFlag) {
    await app.prisma.platformConfig.update({ where: { key: CATEGORY_DISCOVERY_FLAG }, data: { value: priorRailFlag.value as never } });
  } else {
    await app.prisma.platformConfig.deleteMany({ where: { key: CATEGORY_DISCOVERY_FLAG } });
  }
  resetDiscoveryCacheForTests();
  if (priorPolicy === undefined) delete process.env['TENANT_UNSCOPED_ACCESS']; else process.env['TENANT_UNSCOPED_ACCESS'] = priorPolicy;
  await app.close();
  if (priorRunWorkers === undefined) delete process.env['RUN_WORKERS']; else process.env['RUN_WORKERS'] = priorRunWorkers;
});

const withDummyParams = (url: string) => url.replace(/:[a-zA-Z_]+\??/g, 'x').replace(/\*/g, 'x');
const isGet = (r: RouteOptions) => (Array.isArray(r.method) ? r.method : [r.method]).includes('GET');

describe('[STA-1 4.1] deny-readiness of every public GET', () => {
  it('the census is not vacuous', () => {
    expect(routes.filter(isGet).length).toBeGreaterThan(50);
  });

  it('every GET answered anonymously under deny without TENANT_CONTEXT_REQUIRED, except the register — which only shrinks', async () => {
    const unready: string[] = [];
    for (const r of routes.filter(isGet)) {
      const res = await app.inject({ method: 'GET', url: withDummyParams(r.url) });
      const body = res.body;
      if (res.statusCode === 500 && /TENANT_CONTEXT_REQUIRED/.test(body)) unready.push(r.url);
    }
    expect(unready.sort()).toEqual([...DENY_UNREADY_GETS].sort());
  }, 120_000);
});

/** The browse surfaces a customer reaches from Home — the category rail
 *  (discovery), the market, search, and the Home and store pages — which a
 *  guest and a signed-in customer both call. */
const BROWSE_PREFIXES = ['/api/v1/discovery', '/api/v1/market', '/api/v1/search'];
const BROWSE_CUSTOMER = new Set(['/api/v1/customer/home', '/api/v1/customer/vendors', '/api/v1/customer/vendors/:id', '/api/v1/customer/vendors/:id/reviews']);
const isBrowse = (url: string) => BROWSE_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`)) || BROWSE_CUSTOMER.has(url);

describe('[Q12-B] the browse surfaces bind a tenant under deny — as a guest AND signed in, with the rail ON', () => {
  it('the category rail answers under deny with its flag ON: the guest gets the public catalogue, the customer their own tenant', async () => {
    resetDiscoveryCacheForTests();
    const guest = await app.inject({ method: 'GET', url: '/api/v1/discovery/categories' });
    expect(guest.statusCode, guest.body).toBe(200);
    expect(guest.json().data.enabled).toBe(true);
    resetDiscoveryCacheForTests();
    const signedIn = await app.inject({ method: 'GET', url: '/api/v1/discovery/categories', headers: { authorization: `Bearer ${customer!.token}` } });
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.json().data.enabled).toBe(true);
    // A credential that does not verify is refused like everywhere else on
    // the strict session path — never quietly served as a guest.
    const forged = await app.inject({ method: 'GET', url: '/api/v1/discovery/categories', headers: { authorization: 'Bearer not-a-token' } });
    expect(forged.statusCode).toBe(401);
  });

  it('every GET of discovery, market, search and the Home/store pages: never TENANT_CONTEXT_REQUIRED, whoever asks', async () => {
    const browse = routes.filter(isGet).filter((r) => isBrowse(r.url));
    // Not vacuous: the rail, the market, search and Home are all in the sweep.
    for (const must of ['/api/v1/discovery/categories', '/api/v1/market/items', '/api/v1/search', '/api/v1/customer/home']) {
      expect(browse.map((r) => r.url), must).toContain(must);
    }
    const unready: string[] = [];
    for (const r of browse) {
      for (const who of ['guest', 'signed-in'] as const) {
        resetDiscoveryCacheForTests();
        const res = await app.inject({
          method: 'GET',
          url: withDummyParams(r.url),
          ...(who === 'signed-in' ? { headers: { authorization: `Bearer ${customer!.token}` } } : {}),
        });
        if (res.statusCode === 500 && /TENANT_CONTEXT_REQUIRED/.test(res.body)) unready.push(`${who} ${r.url}`);
      }
    }
    expect(unready).toEqual([]);
  }, 120_000);
});
