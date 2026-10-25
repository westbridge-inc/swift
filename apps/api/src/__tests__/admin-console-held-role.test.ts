import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { searchRoutes } from '../modules/search/search.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { beginRequestTenantContext, runWithoutTenant } from '../plugins/tenant-context';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { isActiveDocumentReviewer } from '../modules/admin/document-reviewer';
import { consoleRoleOf } from '../modules/auth/console-role';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [ADMIN-ROLE] CONSOLE AUTHORITY IS THE ADMIN ROLE AN ACCOUNT HOLDS, NEVER THE
// PHONE APP'S ACTIVE MODE.
//
// Found in testing (25 Oct 2026): a SUPER_ADMIN account that also holds the
// customer and mover roles was moved into rider mode by the phone app (partner
// onboarding's PUT /partner/vehicle), later into customer mode (the role
// switcher), and from then on every console call came back 403 'Admin access
// required': the console guard read the role the request carried, which
// authentication copies from users.activeRole, and no route can switch an
// account back into an admin mode. The same trap waits on production the day
// an admin's number is used in a partner mode.
//
// The rule now: the console, the founder controls, Mission Control's ops
// routes, the document viewer and the account-status ranking all read the
// admin role the account HOLDS (users.roles, read with the session on every
// request). A mode never grants anything; removing the role refuses the very
// next request; tenant scoping, the founder rule and the two-person rule are
// unchanged; the phone's own mode is untouched.
//
// Fixtures are synthetic (+59206 block via testPhone) and written unscoped,
// as in sos-platform-responder.test.ts.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const REASON = 'Console check after the phone switched this account into rider mode';
const userIds: string[] = [];
const tenants: string[] = [];
const alertIds: string[] = [];

interface Actor { token: string; userId: string; sessionId: string }

/** The reported account's shape: SUPER_ADMIN plus the app roles, phone in rider mode. */
const OWNER_IN_RIDER_MODE = { roles: ['SUPER_ADMIN', 'CUSTOMER', 'MOVER', 'RIDER'] as UserRole[], activeRole: 'RIDER' as UserRole };

async function makeTenant(): Promise<string> {
  const id = `admin-role-${RUN}-${tenants.length}`;
  await runWithoutTenant(() => app.prisma.tenant.create({ data: { id, name: `Admin role ${id}`, slug: id, isActive: true } }), 'test-fixture:admin-role');
  tenants.push(id);
  return id;
}

async function makeAccount(opts: {
  roles: UserRole[]; activeRole: UserRole; tenantId?: string; permissions?: string[] | null; email?: string;
}): Promise<Actor> {
  return runWithoutTenant(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: testPhone(), firstName: 'Console', lastName: `Role${RUN}${userIds.length}`,
        roles: opts.roles, activeRole: opts.activeRole,
        lastMoverRole: opts.activeRole === 'RIDER' || opts.activeRole === 'DRIVER' ? opts.activeRole : null,
        status: 'ACTIVE', isPhoneVerified: true, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
        ...(opts.email ? { email: opts.email } : {}),
        ...(opts.permissions ? { admin: { create: { permissions: opts.permissions } } } : {}),
      },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: opts.activeRole, jti: nanoid(8) });
    const session = await app.prisma.session.create({
      data: {
        userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
        deviceId: 'admin-console-held-role', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return { token, userId: user.id, sessionId: session.id };
  }, 'test-fixture:admin-role');
}

const call = (actor: Actor, method: string, url: string, payload?: Record<string, unknown>) => app.inject({
  method: method as never, url,
  headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json', 'x-swift-reason': REASON },
  ...(payload === undefined ? {} : { payload }),
});

/** Read outside any request scope. */
const userRow = (id: string) => runWithoutTenant(
  () => app.prisma.user.findUniqueOrThrow({ where: { id }, select: { status: true, activeRole: true, roles: true } }),
  'test-fixture:admin-role',
);
const setRoles = (id: string, roles: UserRole[]) => runWithoutTenant(
  () => app.prisma.user.update({ where: { id }, data: { roles: { set: roles } } }),
  'test-fixture:admin-role',
);
const approvalRow = (id: string) => runWithoutTenant(
  () => app.prisma.privilegedApproval.findUniqueOrThrow({ where: { id } }),
  'test-fixture:admin-role',
);

async function makeAlert(actorUserId: string, tenantId: string | null) {
  return runWithoutTenant(async () => {
    const a = await app.prisma.sosAlert.create({
      data: { actorUserId, actorRole: 'CUSTOMER', status: 'ACTIVE', triggerSource: 'BUTTON', tenantId },
    });
    alertIds.push(a.id);
    return a;
  }, 'test-fixture:admin-role');
}

const savedMeiliUrl = process.env['MEILISEARCH_URL'];

beforeAll(async () => {
  // An unreachable index: the admin-only re-sync answers 503 past its gate, never a real sync.
  // Restored in afterAll: suites share the process, and a later one must not inherit it.
  process.env['MEILISEARCH_URL'] = 'http://127.0.0.1:9';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  // Production opens a fresh per-request tenant store BEFORE auth (server.ts).
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  // What an ordinary (non-console) route sees: the app's own mode, untouched.
  app.get('/probe/mode', { preHandler: [app.authenticate] }, async (request) => ({ role: request.user.role }));
  await app.ready();
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.sosAlert.deleteMany({ where: { id: { in: alertIds } } }).catch(() => {});
    await app.prisma.privilegedApproval.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await app.prisma.batchingSettings.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: userIds } }] }, 'test-cleanup:admin-console-held-role').catch(() => 0);
    await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: userIds } } }, { driver: { userId: { in: userIds } } }] } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.prisma.tenant.deleteMany({ where: { id: { in: tenants } } }).catch(() => {});
  }, 'test-cleanup:admin-console-held-role');
  await app.close();
  if (savedMeiliUrl === undefined) delete process.env['MEILISEARCH_URL']; else process.env['MEILISEARCH_URL'] = savedMeiliUrl;
});

describe('[ADMIN-ROLE] the console follows the admin role the account holds', () => {
  it('the reported case: a SUPER_ADMIN whose phone switched it into rider mode runs the console, the founder controls and the platform controls', async () => {
    const owner = await makeAccount({ ...OWNER_IN_RIDER_MODE, permissions: ['*'] });

    const users = await call(owner, 'GET', '/api/v1/admin/users?limit=1');
    expect(users.statusCode, users.body).toBe(200);
    const founder = await call(owner, 'GET', '/api/v1/admin/staff/document-reviewers');
    expect(founder.statusCode, founder.body).toBe(200);
    const platform = await call(owner, 'GET', '/api/v1/admin/config');
    expect(platform.statusCode, platform.body).toBe(200);

    // The phone's mode is untouched: using the console moves nothing, and an
    // ordinary route still sees the rider mode the app chose.
    expect((await userRow(owner.userId)).activeRole).toBe('RIDER');
    const mode = await call(owner, 'GET', '/probe/mode');
    expect(mode.statusCode, mode.body).toBe(200);
    expect(mode.json().role).toBe('RIDER');
  });

  it('account-status actions are ranked by the held role: a SUPER_ADMIN in rider mode bans an ADMIN and lifts the ban (SUPER_ADMIN only), recorded under their own id', async () => {
    const owner = await makeAccount({ ...OWNER_IN_RIDER_MODE, permissions: ['*'] });
    const target = await makeAccount({ roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', permissions: ['*'] });

    const banned = await call(owner, 'PUT', `/api/v1/admin/users/${target.userId}/ban`, { reason: REASON });
    expect(banned.statusCode, banned.body).toBe(200);
    expect((await userRow(target.userId)).status).toBe('BANNED');
    const lifted = await call(owner, 'PUT', `/api/v1/admin/users/${target.userId}/unban`, { reason: REASON });
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect((await userRow(target.userId)).status).toBe('ACTIVE');

    // The audit trail names the person who acted (the backstop row lands after the response).
    const actorOf = async () => runWithoutTenant(() => app.prisma.auditLog.findMany({
      where: { entityId: target.userId, action: { startsWith: 'ADMIN PUT /api/v1/admin/users/' } },
      select: { userId: true, action: true },
    }), 'test-fixture:admin-role');
    const deadline = Date.now() + 10_000;
    let rows = await actorOf();
    while (rows.length < 2 && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 50)); rows = await actorOf(); }
    expect(rows.map((r) => r.action).sort()).toEqual([
      'ADMIN PUT /api/v1/admin/users/:id/ban',
      'ADMIN PUT /api/v1/admin/users/:id/unban',
    ]);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([owner.userId]));
  });

  it("Mission Control's ops routes follow the held role too: a paged SUPER_ADMIN in rider mode lists and acknowledges an SOS", async () => {
    const owner = await makeAccount({ ...OWNER_IN_RIDER_MODE, permissions: ['*'] });
    const person = await makeAccount({ roles: ['CUSTOMER'], activeRole: 'CUSTOMER' });
    const alert = await makeAlert(person.userId, 'swift-default');

    const board = await call(owner, 'GET', '/api/v1/safety/sos?status=open&limit=200');
    expect(board.statusCode, board.body).toBe(200);
    expect(board.json().data.map((a: { id: string }) => a.id)).toContain(alert.id);
    expect((await call(owner, 'GET', '/api/v1/safety/ops-alerts')).statusCode).toBe(200);
    const ack = await call(owner, 'POST', `/api/v1/safety/sos/${alert.id}/ack`, {});
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json().data.status).toBe('ACKNOWLEDGED');

    // and the admin-only search re-sync passes its gate (503: no index here)
    const sync = await call(owner, 'POST', '/api/v1/search/sync', {});
    expect(sync.statusCode, sync.body).toBe(503);
  });

  it('the document viewer re-check reads the held role: a reviewer in rider mode still sees the document; a mode or a removed role never does', async () => {
    const tenantId = await makeTenant();
    const subject = await makeAccount({ roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId });
    const reviewer = await makeAccount({ ...OWNER_IN_RIDER_MODE, tenantId, permissions: ['documents.review'] });
    const modeOnly = await makeAccount({ roles: ['CUSTOMER'], activeRole: 'ADMIN', tenantId, permissions: ['documents.review'] });
    const elsewhere = await makeAccount({ roles: ['CUSTOMER'], activeRole: 'CUSTOMER' });

    const check = (who: string, owner: string) => runWithoutTenant(() => isActiveDocumentReviewer(app.prisma, who, owner), 'test-fixture:admin-role');
    expect(await check(reviewer.userId, subject.userId)).toBe(true);
    // unchanged: never another tenant's person
    expect(await check(reviewer.userId, elsewhere.userId)).toBe(false);
    // a mode never grants it
    expect(await check(modeOnly.userId, subject.userId)).toBe(false);
    // the staff role removed: refused on the next load, grant still on the row
    await setRoles(reviewer.userId, ['CUSTOMER', 'MOVER', 'RIDER']);
    expect(await check(reviewer.userId, subject.userId)).toBe(false);
  });
});

/** A second live session for the same account: the console in a browser beside the phone. */
const secondSession = (userId: string, role: UserRole) => runWithoutTenant(async () => {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-console-held-role-console', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { token, userId, sessionId: session.id } as Actor;
}, 'test-fixture:admin-role');

describe("[ADMIN-ROLE] the two phone paths that move an admin account's mode, end to end", () => {
  /** The console checks it after each flip: a console read, a founder control and a platform control. */
  async function consoleWorks(consoleSession: Actor) {
    const users = await call(consoleSession, 'GET', '/api/v1/admin/users?limit=1');
    expect(users.statusCode, users.body).toBe(200);
    const founder = await call(consoleSession, 'GET', '/api/v1/admin/staff/document-reviewers');
    expect(founder.statusCode, founder.body).toBe(200);
    const platform = await call(consoleSession, 'GET', '/api/v1/admin/config');
    expect(platform.statusCode, platform.body).toBe(200);
  }
  async function phoneMode(phone: Actor): Promise<string> {
    const res = await call(phone, 'GET', '/probe/mode');
    expect(res.statusCode, res.body).toBe(200);
    return res.json().role as string;
  }

  it('flip 1, partner onboarding: becoming a rider and then PUT /partner/vehicle move the account into rider mode; the console keeps working and the phone stays a rider', async () => {
    const phone = await makeAccount({ roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', permissions: ['*'] });
    await runWithoutTenant(() => app.prisma.user.update({ where: { id: phone.userId }, data: { countryCode: 'GY', selfieCapturedAt: new Date(), avatar: `/uploads/avatars/admin-role-${RUN}.jpg` } }), 'test-fixture:admin-role');
    const consoleSession = await secondSession(phone.userId, 'SUPER_ADMIN');
    await consoleWorks(consoleSession);

    const became = await call(phone, 'POST', '/api/v1/partner/become', { role: 'MOVER', acceptAgreement: true, vehicleType: 'MOTORCYCLE' });
    expect(became.statusCode, became.body).toBe(201);
    const changed = await call(phone, 'PUT', '/api/v1/partner/vehicle', { vehicleType: 'BICYCLE' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().data.activeRole).toBe('RIDER');
    const row = await userRow(phone.userId);
    expect(row.activeRole).toBe('RIDER');
    expect(row.roles).toEqual(expect.arrayContaining(['SUPER_ADMIN', 'RIDER']));

    await consoleWorks(consoleSession);
    expect(await phoneMode(phone)).toBe('RIDER');
    expect((await userRow(phone.userId)).activeRole, 'the console moved nothing').toBe('RIDER');
  });

  it('flip 2, the role switcher: POST /customer/switch-role to customer and back to mover; the console keeps working and the phone keeps each mode it chose', async () => {
    const phone = await makeAccount({ ...OWNER_IN_RIDER_MODE, permissions: ['*'] });
    await runWithoutTenant(() => app.prisma.rider.create({ data: { userId: phone.userId, riderType: 'BOTH', vehicleType: 'MOTORCYCLE' } }), 'test-fixture:admin-role');
    const consoleSession = await secondSession(phone.userId, 'SUPER_ADMIN');

    const toCustomer = await call(phone, 'POST', '/api/v1/customer/switch-role', { role: 'CUSTOMER' });
    expect(toCustomer.statusCode, toCustomer.body).toBe(200);
    expect((await userRow(phone.userId)).activeRole).toBe('CUSTOMER');
    await consoleWorks(consoleSession);
    expect(await phoneMode(phone)).toBe('CUSTOMER');

    const toMover = await call(phone, 'POST', '/api/v1/customer/switch-role', { role: 'MOVER' });
    expect(toMover.statusCode, toMover.body).toBe(200);
    expect((await userRow(phone.userId)).activeRole).toBe('RIDER');
    await consoleWorks(consoleSession);
    expect(await phoneMode(phone)).toBe('RIDER');

    // The switcher still offers no admin mode (unchanged): the console no longer needs one.
    expect((await call(phone, 'POST', '/api/v1/customer/switch-role', { role: 'SUPER_ADMIN' })).statusCode).toBe(400);
    expect((await userRow(phone.userId)).activeRole).toBe('RIDER');
  });

  it('control: the same two paths never open the console to an account that holds no admin role', async () => {
    const phone = await makeAccount({ roles: ['CUSTOMER'], activeRole: 'CUSTOMER' });
    await runWithoutTenant(() => app.prisma.user.update({ where: { id: phone.userId }, data: { countryCode: 'GY', selfieCapturedAt: new Date(), avatar: `/uploads/avatars/admin-role-c-${RUN}.jpg` } }), 'test-fixture:admin-role');
    expect((await call(phone, 'POST', '/api/v1/partner/become', { role: 'MOVER', acceptAgreement: true, vehicleType: 'MOTORCYCLE' })).statusCode).toBe(201);
    expect((await call(phone, 'PUT', '/api/v1/partner/vehicle', { vehicleType: 'BICYCLE' })).statusCode).toBe(200);
    expect((await call(phone, 'GET', '/api/v1/admin/users?limit=1')).statusCode).toBe(403);
    expect((await call(phone, 'POST', '/api/v1/customer/switch-role', { role: 'CUSTOMER' })).statusCode).toBe(200);
    expect((await call(phone, 'GET', '/api/v1/admin/users?limit=1')).statusCode).toBe(403);
    expect((await call(phone, 'GET', '/api/v1/safety/sos')).statusCode).toBe(403);
  });
});

describe('[ADMIN-ROLE] the founder and second-person rules are unchanged', () => {
  it('the one admin of a tenant, in rider mode, asks for a platform change and starts solo mode (SUPER_ADMIN only)', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAccount({ ...OWNER_IN_RIDER_MODE, tenantId, permissions: ['*'], email: `owner-${RUN}@example.test` });

    const asked = await call(owner, 'PUT', '/api/v1/admin/batching/settings', { maxOrdersPerRun: 2, reason: REASON });
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json().error.details.approvalId as string;
    const solo = await call(owner, 'POST', `/api/v1/admin/approvals/${id}/solo`, {});
    expect(solo.statusCode, solo.body).toBe(200);
    expect((await approvalRow(id)).requestedBy).toBe(owner.userId);
  });

  it('a second admin in rider mode is still a second admin: solo is refused, self-approval is refused, and the second admin decides from the console', async () => {
    const tenantId = await makeTenant();
    const owner = await makeAccount({ ...OWNER_IN_RIDER_MODE, tenantId, permissions: ['*'] });
    const second = await makeAccount({ roles: ['ADMIN', 'CUSTOMER', 'MOVER', 'RIDER'], activeRole: 'RIDER', tenantId, permissions: ['*'] });

    const asked = await call(owner, 'PUT', '/api/v1/admin/batching/settings', { maxOrdersPerRun: 3, reason: REASON });
    expect(asked.statusCode, asked.body).toBe(202);
    const id = asked.json().error.details.approvalId as string;

    const solo = await call(owner, 'POST', `/api/v1/admin/approvals/${id}/solo`, {});
    expect(solo.statusCode, solo.body).toBe(403);
    expect(solo.json().error.code).toBe('SOLO_SECOND_ADMIN');
    const self = await call(owner, 'POST', `/api/v1/admin/approvals/${id}/decide`, { approve: true, reason: REASON });
    expect(self.statusCode, self.body).toBe(403);
    expect((await approvalRow(id)).status).toBe('PENDING');

    const decided = await call(second, 'POST', `/api/v1/admin/approvals/${id}/decide`, { approve: true, reason: REASON });
    expect(decided.statusCode, decided.body).toBe(200);
    const row = await approvalRow(id);
    expect(row.status).toBe('APPROVED');
    expect(row.approvedBy).toBe(second.userId);
  });
});

describe('[ADMIN-ROLE] nothing is widened', () => {
  it.each([
    { label: 'customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER' },
    { label: 'rider', roles: ['MOVER', 'CUSTOMER', 'RIDER'], activeRole: 'RIDER' },
    { label: 'driver', roles: ['MOVER', 'CUSTOMER', 'DRIVER'], activeRole: 'DRIVER' },
    { label: 'store owner', roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER' },
  ] as Array<{ label: string; roles: UserRole[]; activeRole: UserRole }>)('a $label is never admin: console, founder, platform, ops and re-sync all refuse', async ({ roles, activeRole }) => {
    const person = await makeAccount({ roles, activeRole });
    const console_ = await call(person, 'GET', '/api/v1/admin/users?limit=1');
    expect(console_.statusCode).toBe(403);
    expect(console_.json().error.message).toBe('Admin access required');
    expect((await call(person, 'GET', '/api/v1/admin/staff/document-reviewers')).statusCode).toBe(403);
    expect((await call(person, 'GET', '/api/v1/admin/config')).statusCode).toBe(403);
    expect((await call(person, 'GET', '/api/v1/safety/sos')).statusCode).toBe(403);
    expect((await call(person, 'GET', '/api/v1/safety/ops-alerts')).statusCode).toBe(403);
    expect((await call(person, 'POST', '/api/v1/search/sync', {})).statusCode).toBe(403);
  });

  it.each(['ADMIN', 'SUPER_ADMIN'] as UserRole[])('a mode never grants: an account in %s mode that does not hold the role is refused everywhere', async (mode) => {
    const person = await makeAccount({ roles: ['CUSTOMER'], activeRole: mode, permissions: ['*'] });
    const console_ = await call(person, 'GET', '/api/v1/admin/users?limit=1');
    expect(console_.statusCode, console_.body).toBe(403);
    expect(console_.json().error.message).toBe('Admin access required');
    expect((await call(person, 'GET', '/api/v1/admin/config')).statusCode).toBe(403);
    expect((await call(person, 'GET', '/api/v1/safety/sos')).statusCode).toBe(403);
    expect((await call(person, 'POST', '/api/v1/search/sync', {})).statusCode).toBe(403);
  });

  it('a removed admin role is refused on the very next request, on the same session (an admin left in an admin mode too)', async () => {
    const admin = await makeAccount({ roles: ['ADMIN', 'CUSTOMER'], activeRole: 'ADMIN', permissions: ['*'] });
    const owner = await makeAccount({ ...OWNER_IN_RIDER_MODE, permissions: ['*'] });
    expect((await call(admin, 'GET', '/api/v1/admin/users?limit=1')).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/api/v1/admin/users?limit=1')).statusCode).toBe(200);

    await setRoles(admin.userId, ['CUSTOMER']);
    await setRoles(owner.userId, ['CUSTOMER', 'MOVER', 'RIDER']);

    for (const actor of [admin, owner]) {
      const refused = await call(actor, 'GET', '/api/v1/admin/users?limit=1');
      expect(refused.statusCode, refused.body).toBe(403);
      expect((await call(actor, 'GET', '/api/v1/admin/staff/document-reviewers')).statusCode).toBe(403);
      expect((await call(actor, 'GET', '/api/v1/safety/sos')).statusCode).toBe(403);
    }
    // the mode the row was left in is not authority
    expect((await userRow(admin.userId)).activeRole).toBe('ADMIN');
  });

  it("another tenant's admin in rider mode stays inside their tenant and off the platform controls", async () => {
    const tenantId = await makeTenant();
    const other = await makeAccount({ ...OWNER_IN_RIDER_MODE, tenantId, permissions: ['*'] });
    const home = await makeAccount({ roles: ['CUSTOMER'], activeRole: 'CUSTOMER' });

    expect((await call(other, 'GET', '/api/v1/admin/users?limit=1')).statusCode).toBe(200);
    const foreign = await call(other, 'GET', `/api/v1/admin/users/${home.userId}`);
    expect(foreign.statusCode, foreign.body).toBe(404);
    const platform = await call(other, 'GET', '/api/v1/admin/config');
    expect(platform.statusCode, platform.body).toBe(403);
    expect(platform.json().error.message).toBe('Platform controls require the default tenant');
  });

  it('the held-role rule itself: the higher admin role wins, nothing else counts', () => {
    expect(consoleRoleOf(['SUPER_ADMIN', 'CUSTOMER', 'MOVER', 'RIDER'])).toBe('SUPER_ADMIN');
    expect(consoleRoleOf(['ADMIN', 'SUPER_ADMIN'])).toBe('SUPER_ADMIN');
    expect(consoleRoleOf(['CUSTOMER', 'ADMIN'])).toBe('ADMIN');
    for (const roles of [['CUSTOMER'], ['MOVER', 'RIDER'], ['VENDOR_OWNER'], [], null, undefined, ['ADMIN_MAYBE'], ['admin']]) {
      expect(consoleRoleOf(roles as string[] | null | undefined)).toBeNull();
    }
  });
});
