import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';

// ---------------------------------------------------------------------------
// [TA-S0-004] A platform SOS responder can ACT on what they are paged for.
//
// notifyAdmins pages SUPER_ADMIN for every tenant's alert and for the
// null-tenant ones — that page deliberately escapes tenant scope. But every
// authenticated request, SUPER_ADMIN's included, is bound to the caller's own
// tenant, and the Prisma extension scopes SosAlert. So the responder who was
// just paged opened the board and saw nothing, opened the alert and got 404,
// and could neither acknowledge nor resolve it. The privilege that pages them
// is the privilege that lets them act — through the real route stack, for a
// tenant-B alert and a null-tenant alert. A tenant ADMIN stays scoped: the
// rule is unchanged, this is its one sanctioned exception.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdAlertIds: string[] = [];
let tenantB: string;
let seq = 0;
const phoneBase = 592_709_000_000 + Math.floor(Math.random() * 50_000_000);

// Fixtures are written UNSCOPED on purpose: a request's tenant binding leaks
// into the test's own async context after the first authenticated call, and
// the extension stamps tenantId LAST on every create — so without this a
// "tenant-B" fixture would silently land in the default tenant.
async function makeUser(roles: UserRole[], tenantId: string | null) {
  seq += 1;
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: `+${phoneBase + seq}`, firstName: 'Responder', lastName: `U${seq}`, roles, activeRole: roles[0]!,
        isPhoneVerified: true, selfieCapturedAt: new Date(), ...(tenantId ? { tenantId } : {}),
      },
    });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'resp', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    return { userId: user.id, token };
  });
}

/** Written directly and unscoped — the way fanOut's own rows come out. */
async function makeAlert(actorUserId: string, tenantId: string | null) {
  return runWithoutTenant(async () => {
    const a = await app.prisma.sosAlert.create({
      data: { actorUserId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', tenantId },
    });
    createdAlertIds.push(a.id);
    return a;
  });
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, token: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload });
const idsOf = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.map((a) => a.id);
/** The truth, read outside any request scope. */
const statusOf = (id: string) => runWithoutTenant(async () => (await app.prisma.sosAlert.findUniqueOrThrow({ where: { id }, select: { status: true } })).status);

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  // Production opens a fresh per-request tenant store BEFORE auth (server.ts);
  // without it this isolated host would lose the binding across the auth
  // await and run every query unscoped — proving nothing about scope.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.ready();
  tenantB = (await app.prisma.tenant.create({ data: { id: `sos-resp-b-${nanoid(8)}`, name: 'Responder Test Tenant B', slug: `sos-resp-b-${nanoid(8)}` } })).id;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.sosAlert.deleteMany({ where: { id: { in: createdAlertIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: tenantB } });
  });
  await app.close();
});

describe('[TA-S0-004] the platform responder acts on what they are paged for', () => {
  it('a SUPER_ADMIN bound to the default tenant lists, opens, acknowledges and resolves a tenant-B alert and a null-tenant alert through the real routes', async () => {
    const platform = await makeUser(['SUPER_ADMIN'], 'swift-default');
    const actorB = await makeUser(['CUSTOMER'], tenantB);
    const actorHome = await makeUser(['CUSTOMER'], 'swift-default');
    const alertB = await makeAlert(actorB.userId, tenantB);
    const alertNull = await makeAlert(actorB.userId, null);
    const alertHome = await makeAlert(actorHome.userId, 'swift-default');

    // The board: every open alert, whatever tenant it belongs to — or none.
    const board = idsOf(await get('/api/v1/safety/sos', platform.token));
    expect(board).toEqual(expect.arrayContaining([alertB.id, alertNull.id, alertHome.id]));

    // Open.
    expect((await get(`/api/v1/safety/sos/${alertB.id}`, platform.token)).statusCode).toBe(200);
    expect((await get(`/api/v1/safety/sos/${alertNull.id}`, platform.token)).statusCode).toBe(200);

    // Acknowledge.
    const ackB = await post(`/api/v1/safety/sos/${alertB.id}/ack`, platform.token);
    expect(ackB.statusCode).toBe(200);
    expect(ackB.json().data.status).toBe('ACKNOWLEDGED');
    const ackNull = await post(`/api/v1/safety/sos/${alertNull.id}/ack`, platform.token);
    expect(ackNull.statusCode).toBe(200);
    expect(ackNull.json().data.status).toBe('ACKNOWLEDGED');

    // Resolve.
    const resB = await post(`/api/v1/safety/sos/${alertB.id}/resolve`, platform.token, { resolutionCode: 'SAFE_CONFIRMED' });
    expect(resB.statusCode).toBe(200);
    expect(resB.json().data.status).toBe('RESOLVED');
    const resNull = await post(`/api/v1/safety/sos/${alertNull.id}/resolve`, platform.token, { resolutionCode: 'SAFE_CONFIRMED', notes: 'Responder reached the person.' });
    expect(resNull.statusCode).toBe(200);
    expect(resNull.json().data.status).toBe('RESOLVED');

    expect(await statusOf(alertB.id)).toBe('RESOLVED');
    expect(await statusOf(alertNull.id)).toBe('RESOLVED');
  });

  it('a tenant ADMIN stays inside their tenant: another tenant’s alert and a null-tenant alert are neither listed nor actionable, and stay untouched', async () => {
    const tenantAdmin = await makeUser(['ADMIN'], 'swift-default');
    const actorB = await makeUser(['CUSTOMER'], tenantB);
    const actorHome = await makeUser(['CUSTOMER'], 'swift-default');
    const alertB = await makeAlert(actorB.userId, tenantB);
    const alertNull = await makeAlert(actorB.userId, null);
    const alertHome = await makeAlert(actorHome.userId, 'swift-default');

    const board = idsOf(await get('/api/v1/safety/sos?status=all', tenantAdmin.token));
    expect(board).toContain(alertHome.id);
    expect(board).not.toContain(alertB.id);
    expect(board).not.toContain(alertNull.id);

    for (const id of [alertB.id, alertNull.id]) {
      expect((await get(`/api/v1/safety/sos/${id}`, tenantAdmin.token)).statusCode).toBe(404);
      const ack = await post(`/api/v1/safety/sos/${id}/ack`, tenantAdmin.token);
      expect(ack.statusCode).not.toBe(200);
      const resolve = await post(`/api/v1/safety/sos/${id}/resolve`, tenantAdmin.token, { resolutionCode: 'SAFE_CONFIRMED' });
      expect(resolve.statusCode).not.toBe(200);
      expect(await statusOf(id)).toBe('ACTIVE'); // nothing moved
    }
    // Their own tenant's alert is still theirs to work.
    expect((await post(`/api/v1/safety/sos/${alertHome.id}/ack`, tenantAdmin.token)).statusCode).toBe(200);
  });

  it('a customer is still refused the board, platform alerts included', async () => {
    const customer = await makeUser(['CUSTOMER'], 'swift-default');
    expect((await get('/api/v1/safety/sos', customer.token)).statusCode).toBe(403);
  });
});
