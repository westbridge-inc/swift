import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeAuditLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [DS110 #12] ANY ADMIN COULD PERMANENTLY BAN OR SUSPEND THE SUPER_ADMIN.
//
// The ban guard tested `user.roles.includes('ADMIN')`, but the only code that
// mints a SUPER_ADMIN writes `roles: ['SUPER_ADMIN', 'CUSTOMER']` — no ADMIN
// entry — so the guard never fired for the founder. Suspension had no role
// check at all, and no route could ever unban (the status authority refused
// BANNED → ACTIVE), so one ordinary admin could lock the platform out of its
// own governance with a single call.
//
// The fix is a role hierarchy on ban/suspend (an actor can never act on an
// equal or higher role, or on themselves), plus an audited SUPER_ADMIN-only
// unban route.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const REASON = 'Repeated platform-control abuse after three documented warnings';

async function makeAdmin(role: 'ADMIN' | 'SUPER_ADMIN'): Promise<{ token: string; userId: string }> {
  const phone = `+59241${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Hierarchy', lastName: `${role.slice(0, 3)}${RUN}`,
      roles: [role, 'CUSTOMER'], activeRole: role, status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-role-hierarchy', deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { token, userId: user.id };
}

async function makeCustomer(): Promise<string> {
  const phone = `+59241${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Hierarchy', lastName: `Victim${RUN}${userIds.length}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  return user.id;
}

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as never, url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

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
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-role-hierarchy').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-role-hierarchy');
  await app.close();
});

describe('[DS110 #12] the role hierarchy governs destructive account actions', () => {
  it('an ADMIN cannot ban the SUPER_ADMIN — the founder account stays ACTIVE', async () => {
    const admin = await makeAdmin('ADMIN');
    const superAdmin = await makeAdmin('SUPER_ADMIN');

    const res = await call(admin.token, 'PUT', `/api/v1/admin/users/${superAdmin.userId}/ban`, { reason: REASON });
    expect(res.statusCode, res.body).toBe(403);

    // Durable state, not just the status code: no status change, no session
    // revocation, no retention scheduling.
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: superAdmin.userId } });
    expect(after.status).toBe('ACTIVE');
    expect(await app.prisma.session.count({ where: { userId: superAdmin.userId } })).toBe(1);
  });

  it('an ADMIN cannot suspend the SUPER_ADMIN, and nobody acts on their own account', async () => {
    const admin = await makeAdmin('ADMIN');
    const superAdmin = await makeAdmin('SUPER_ADMIN');

    const suspendFounder = await call(admin.token, 'PUT', `/api/v1/admin/users/${superAdmin.userId}/suspend`, { reason: REASON });
    expect(suspendFounder.statusCode, suspendFounder.body).toBe(403);
    const founderAfter = await app.prisma.user.findUniqueOrThrow({ where: { id: superAdmin.userId } });
    expect(founderAfter.status).toBe('ACTIVE');

    const selfBan = await call(admin.token, 'PUT', `/api/v1/admin/users/${admin.userId}/ban`, { reason: REASON });
    expect(selfBan.statusCode, selfBan.body).toBe(403);
    const selfAfter = await app.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(selfAfter.status).toBe('ACTIVE');
  });

  it('the hierarchy still lets a SUPER_ADMIN ban an ordinary account, and its unban is audited', async () => {
    const superAdmin = await makeAdmin('SUPER_ADMIN');
    const victimId = await makeCustomer();

    // The legal path into a ban: SUPER_ADMIN outranks CUSTOMER.
    const ban = await call(superAdmin.token, 'PUT', `/api/v1/admin/users/${victimId}/ban`, { reason: REASON });
    expect(ban.statusCode, ban.body).toBe(200);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: victimId } })).status).toBe('BANNED');

    // Only SUPER_ADMIN may unban: an ordinary ADMIN is refused.
    const admin = await makeAdmin('ADMIN');
    const denied = await call(admin.token, 'PUT', `/api/v1/admin/users/${victimId}/unban`, { reason: REASON });
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: victimId } })).status).toBe('BANNED');

    // The unban restores the account and leaves the authority audit row.
    const unban = await call(superAdmin.token, 'PUT', `/api/v1/admin/users/${victimId}/unban`, { reason: REASON });
    expect(unban.statusCode, unban.body).toBe(200);
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: victimId } })).status).toBe('ACTIVE');
    const audit = await app.prisma.auditLog.findFirst({
      where: { action: 'UNBAN_USER', entity: 'User', entityId: victimId },
    });
    expect(audit).toBeTruthy();
    expect((audit!.changes as { previousStatus: string }).previousStatus).toBe('BANNED');
    // And the admin audit backstop recorded the route with its before/after diff.
    const adminAudit = await app.prisma.auditLog.findFirst({
      where: { userId: superAdmin.userId, action: { contains: '/users/:id/unban' }, entityId: victimId },
    });
    expect(adminAudit).toBeTruthy();

    // A second unban of an ACTIVE account is a refused transition, not a no-op.
    const again = await call(superAdmin.token, 'PUT', `/api/v1/admin/users/${victimId}/unban`, { reason: REASON });
    expect(again.statusCode, again.body).toBe(400);
  });
});
