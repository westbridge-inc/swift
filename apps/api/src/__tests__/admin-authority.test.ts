import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import {
  ADMIN_ACTION_CLASSES, ADMIN_CAPABILITIES, ADMIN_ROUTE_AUTHORITY, SUPPORT_OPERATOR_CAPABILITIES,
  authorityFor, capabilitiesOf, capabilityMatches, capabilityMode, decideCapability, holdsCapability, routeTemplateOf,
} from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [ADM-001] ONE BOOLEAN GOVERNED EVERY ADMIN ACTION.
//
//     if (!['ADMIN', 'SUPER_ADMIN'].includes(request.user.role))
//
// That single line was the entire permission engine for 167 routes — 89 of
// them mutations including ban a user, process a settlement, waive a fee, top
// up an account, mark an invoice paid, set national pricing, change the
// batching algorithm and broadcast to every user. `Admin.permissions` existed
// in the schema, was written as `['*']` by the seed, and was READ BY NOTHING.
// A support agent hired to answer tickets held exactly the authority of the
// founder.
//
// Every route now declares a class (AJ.3) and a capability; the decision is
// made server-side, from the actor's live grant, before the handler runs; and
// a route with no classification is DENIED, because default-allow over an
// unreviewed action is how one boolean came to govern the lot.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const ADMIN_SOURCE = readFileSync(join(process.cwd(), 'src', 'modules', 'admin', 'admin.routes.ts'), 'utf8');

/** Every route `admin.routes.ts` actually registers, method + template. */
function registeredRoutes(): string[] {
  const pattern = /\bapp\.(get|post|put|patch|delete)\s*(?:<[^;]*?>)?\s*\(\s*'([^']+)'/gs;
  const out: string[] = [];
  for (const m of ADMIN_SOURCE.matchAll(pattern)) out.push(`${m[1]!.toUpperCase()} ${m[2]}`);
  return out;
}

async function makeAdmin(permissions: string[] | null, role: 'ADMIN' | 'SUPER_ADMIN' = 'ADMIN'): Promise<string> {
  const phone = `+59276${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Cap', lastName: `Test${RUN}`, roles: [role, 'CUSTOMER'], activeRole: role,
      status: 'ACTIVE', isPhoneVerified: true,
      ...(permissions ? { admin: { create: { permissions } } } : {}),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  // a JWT alone is not a session (SEC-8): the auth plugin requires the row
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-authority', deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return token;
}

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-authority');
  await app.close();
});

describe('[ADM-001] a scoped operator is refused what they do not hold', () => {
  it('a support operator is refused every money and platform action — by the SERVER, whatever the console offers', async () => {
    const token = await makeAdmin([...SUPPORT_OPERATOR_CAPABILITIES]);
    const forbidden: [string, string][] = [
      ['PUT', '/api/v1/admin/finance/settlements/x/process'],
      ['POST', '/api/v1/admin/finance/settlements/x/adjust'],
      ['PUT', '/api/v1/admin/subscriptions/x/waive-fee'],
      ['POST', '/api/v1/admin/subscriptions/x/topup'],
      ['PUT', '/api/v1/admin/ads/invoices/x/mark-paid'],
      ['PUT', '/api/v1/admin/config/DELIVERY_FEE'],
      ['POST', '/api/v1/admin/notifications/broadcast'],
      ['PUT', '/api/v1/admin/users/x/ban'],
      ['DELETE', '/api/v1/admin/dlq/q/1'],
      ['PUT', '/api/v1/admin/countries/GY/pricing/DELIVERY'],
    ];
    for (const [method, url] of forbidden) {
      const res = await call(token, method, url, method === 'GET' ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message, `${method} ${url}`).toMatch(/capability/);
    }
  });

  it('the same operator IS allowed the work they were hired for — this is a scope, not a lockout', async () => {
    const token = await makeAdmin([...SUPPORT_OPERATOR_CAPABILITIES]);
    for (const url of ['/api/v1/admin/support', '/api/v1/admin/dashboard/overview', '/api/v1/admin/orders']) {
      const res = await call(token, 'GET', url);
      expect(res.statusCode, url).not.toBe(403);
    }
  });

  it('a grant is read LIVE — revoking it takes effect on the next request, not on the next token', async () => {
    const token = await makeAdmin(['*']);
    expect((await call(token, 'GET', '/api/v1/admin/finance/revenue')).statusCode).not.toBe(403);
    const userId = userIds[userIds.length - 1]!;
    await app.prisma.admin.update({ where: { userId }, data: { permissions: ['support.read'] } });
    // same token, no re-login
    expect((await call(token, 'GET', '/api/v1/admin/finance/revenue')).statusCode).toBe(403);
  });

  it('a prefix grant covers its family and nothing else', async () => {
    const token = await makeAdmin(['finance.*', 'dashboard.read']);
    expect((await call(token, 'GET', '/api/v1/admin/finance/revenue')).statusCode).not.toBe(403);
    expect((await call(token, 'GET', '/api/v1/admin/subscriptions')).statusCode).toBe(403);
  });

  it('an admin with no grant at all keeps today’s reach — this engine does not silently demote the live identity', async () => {
    const token = await makeAdmin(null);
    expect((await call(token, 'GET', '/api/v1/admin/finance/revenue')).statusCode).not.toBe(403);
    const empty = await makeAdmin([]);
    expect((await call(empty, 'GET', '/api/v1/admin/finance/revenue')).statusCode).not.toBe(403);
  });

  it('the refusal happens BEFORE the handler — a forbidden mutation changes nothing', async () => {
    const token = await makeAdmin(['support.*']);
    const target = await makeAdmin(['support.*']);
    void target;
    const victimId = userIds[userIds.length - 1]!;
    const before = await app.prisma.user.findUniqueOrThrow({ where: { id: victimId }, select: { status: true } });
    const res = await call(token, 'PUT', `/api/v1/admin/users/${victimId}/ban`, { reason: 'because' });
    expect(res.statusCode).toBe(403);
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: victimId }, select: { status: true } });
    expect(after.status).toBe(before.status);
  });
});

describe('[ADM-001] every route is classified, and an unclassified one is denied', () => {
  it('the authority table is 1:1 with the routes the plugin registers — in both directions', () => {
    const registered = new Set(registeredRoutes());
    const classified = new Set(Object.keys(ADMIN_ROUTE_AUTHORITY));
    const unclassified = [...registered].filter((r) => !classified.has(r)).sort();
    const orphaned = [...classified].filter((r) => !registered.has(r)).sort();
    expect(unclassified, 'admin routes with no class or capability').toEqual([]);
    expect(orphaned, 'authority entries for routes that no longer exist').toEqual([]);
    expect(registered.size).toBeGreaterThan(150);
  });

  it('a route with no entry is DENIED, not allowed — default-allow over an unreviewed action is the defect itself', () => {
    const decision = decideCapability({ role: 'SUPER_ADMIN' }, 'POST', '/a-route-nobody-classified');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unregistered-route');
    expect(authorityFor('POST', '/a-route-nobody-classified')).toBeNull();
  });

  it('the money and platform actions the appendix names are classified as money and platform, not as workflow', () => {
    const expected: [string, string][] = [
      ['PUT /finance/settlements/:id/process', 'C4'],
      ['POST /finance/settlements/:id/adjust', 'C4'],
      ['PUT /subscriptions/:id/waive-fee', 'C4'],
      ['POST /subscriptions/:id/topup', 'C4'],
      ['PUT /ads/invoices/:id/mark-paid', 'C4'],
      ['PUT /cash-rules/claims/:id/paid', 'C4'],
      ['POST /billing/settlement-batches/:id/adjust-deposit', 'C4'],
      ['POST /billing/agent-payments', 'C4'],
      ['PUT /returns/:id/resolve', 'C4'],
      ['PUT /config/:key', 'C5'],
      ['PUT /countries/:code/pricing/:kind', 'C5'],
      ['PUT /batching/settings', 'C5'],
      ['POST /notifications/broadcast', 'C5'],
      ['PUT /users/:id/ban', 'C3'],
      ['PUT /verification/:id/reject', 'C3'],
      ['GET /integrity/identity/:userId', 'C1'],
      ['GET /orders/:id/handover-secret', 'C1'],
      ['GET /verification/:id/document-url', 'C1'],
    ];
    for (const [key, cls] of expected) {
      expect(ADMIN_ROUTE_AUTHORITY[key]?.cls, key).toBe(cls);
    }
  });

  it('the classes carry the demands the later clauses hang off — a money action needs a reason AND a second person', () => {
    expect(ADMIN_ACTION_CLASSES.C4).toMatchObject({ requiresReason: true, requiresApproval: true });
    expect(ADMIN_ACTION_CLASSES.C5).toMatchObject({ requiresReason: true, requiresApproval: true });
    expect(ADMIN_ACTION_CLASSES.C3).toMatchObject({ requiresReason: true, requiresApproval: false });
    expect(ADMIN_ACTION_CLASSES.C0).toMatchObject({ requiresReason: false, requiresApproval: false });
  });

  it('no mutating route is classified as a read — a state change cannot hide in C0 or C1', () => {
    const misfiled = Object.entries(ADMIN_ROUTE_AUTHORITY)
      .filter(([key, a]) => !key.startsWith('GET ') && (a.cls === 'C0' || a.cls === 'C1'))
      .map(([key]) => key);
    expect(misfiled).toEqual([]);
  });

  it('every capability is namespaced, so a prefix grant means something', () => {
    for (const capability of ADMIN_CAPABILITIES) {
      expect(capability, capability).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
    }
    expect(ADMIN_CAPABILITIES.length).toBeGreaterThan(50);
  });
});

describe('[ADM-001] the decision itself', () => {
  it('`*` covers everything, a prefix covers its family, an exact name covers itself only', () => {
    expect(capabilityMatches('*', 'finance.settlement.process')).toBe(true);
    expect(capabilityMatches('finance.*', 'finance.settlement.process')).toBe(true);
    // the boundary is the DOT, not the letters: a grant over one namespace
    // must not leak into a sibling whose name merely extends it
    expect(capabilityMatches('user.*', 'users.read')).toBe(false);
    expect(capabilityMatches('ads.*', 'adsettings.write')).toBe(false);
    expect(capabilityMatches('finance.read', 'finance.read')).toBe(true);
    expect(capabilityMatches('finance.read', 'finance.settlement.process')).toBe(false);
    expect(holdsCapability(['support.*', 'order.read'], 'order.read')).toBe(true);
    expect(holdsCapability(['support.*', 'order.read'], 'order.cancel')).toBe(false);
  });

  it('an explicit grant REPLACES the role container rather than adding to it', () => {
    expect(capabilitiesOf({ role: 'SUPER_ADMIN', permissions: ['support.read'] })).toEqual(['support.read']);
    expect(capabilitiesOf({ role: 'ADMIN', permissions: [] })).toEqual(['*']);
    expect(capabilitiesOf({ role: 'CUSTOMER', permissions: [] })).toEqual([]);
    expect(decideCapability({ role: 'SUPER_ADMIN', permissions: ['support.read'] }, 'PUT', '/config/:key').allowed).toBe(false);
  });

  it('the table is keyed on the route TEMPLATE, so a caller cannot dodge the check with their own path data', () => {
    const request = { url: '/api/v1/admin/users/usr_123/ban', routeOptions: { url: '/api/v1/admin/users/:id/ban' } };
    expect(routeTemplateOf(request, '/api/v1/admin')).toBe('/users/:id/ban');
    // and without the template (a 404, no matched route) the raw URL classifies as nothing
    expect(authorityFor('PUT', routeTemplateOf({ url: '/api/v1/admin/users/usr_123/ban' }, '/api/v1/admin'))).toBeNull();
  });

  it('shadow mode is opt-in and exact: anything but the literal word enforces', () => {
    expect(capabilityMode({ ADMIN_CAPABILITY_MODE: 'shadow' } as never)).toBe('shadow');
    expect(capabilityMode({ ADMIN_CAPABILITY_MODE: 'SHADOW' } as never)).toBe('enforce');
    expect(capabilityMode({ ADMIN_CAPABILITY_MODE: 'off' } as never)).toBe('enforce');
    expect(capabilityMode({} as never)).toBe('enforce');
  });
});

describe('[ADM-001] the engine is wired, not merely written', () => {
  it('the permission field is READ by the request path — it was dead schema before this', () => {
    expect(ADMIN_SOURCE).toMatch(/prisma\.admin\.findUnique/);
    expect(ADMIN_SOURCE).toMatch(/decideCapability/);
    // and the decision is taken on the request, before any handler
    expect(ADMIN_SOURCE).toMatch(/addHook\('onRequest'/);
  });

  it('the seeded founder account still holds everything, so the engine changes nothing for the one live identity', () => {
    const seed = readFileSync(join(process.cwd(), 'src', 'modules', 'ops', 'seed-plan.ts'), 'utf8');
    expect(seed).toMatch(/permissions: \['\*'\]/);
    expect(holdsCapability(['*'], 'platform.config.write')).toBe(true);
  });
});
