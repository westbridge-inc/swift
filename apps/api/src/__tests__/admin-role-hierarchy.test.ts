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
// own governance with a single call, and nothing in the console could undo it.
//
// The rule now lives in the status transition itself (mover-authority.ts):
// never your own account, never an equal-or-higher role, and a ban is lifted
// by a SUPER_ADMIN only — through /unban, never through /unsuspend.
//
// Every refusal here is proven on durable state: status, sessions, audit rows
// and notifications of the target are read before and after, and must be
// identical. Fixture range: +59241nnnnn (this file only).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
const REASON = 'Repeated platform-control abuse after three documented warnings';

type Actor = { token: string; userId: string };

async function makeAccount(role: 'ADMIN' | 'SUPER_ADMIN' | 'CUSTOMER'): Promise<Actor> {
  const phone = `+59241${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const privileged = role !== 'CUSTOMER';
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Hierarchy', lastName: `${role.slice(0, 3)}${RUN}${userIds.length}`,
      // Exactly how the seed mints the founder: no ADMIN entry beside SUPER_ADMIN.
      roles: privileged ? [role, 'CUSTOMER'] : ['CUSTOMER'],
      activeRole: role, status: 'ACTIVE', isPhoneVerified: true,
      ...(privileged ? { admin: { create: { permissions: ['*'] } } } : {}),
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

const call = (token: string, method: 'PUT', url: string, payload: Record<string, unknown>) =>
  app.inject({
    method, url, payload,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });

/** Everything an account-status action can change about the target. */
async function snapshot(userId: string) {
  const [user, sessions, audit, notifications] = await Promise.all([
    app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } }),
    app.prisma.session.count({ where: { userId } }),
    app.prisma.auditLog.count({ where: { entityId: userId } }),
    app.prisma.notification.count({ where: { userId } }),
  ]);
  return { status: user.status, sessions, audit, notifications };
}

/** The admin audit backstop writes its row AFTER the response is sent; give a
 *  preceding successful action's hook its turn before reading a baseline. */
const settled = () => new Promise((r) => setTimeout(r, 300));

/** A refusal must leave the target exactly as it was — status, sessions, audit
 *  rows and notifications — after the post-response audit hook has had its turn. */
async function expectRefusedUnchanged(
  actor: Actor, action: 'ban' | 'suspend' | 'unsuspend' | 'unban', targetId: string,
  expected: { status: number; code?: string },
) {
  await settled();
  const before = await snapshot(targetId);
  const res = await call(actor.token, 'PUT', `/api/v1/admin/users/${targetId}/${action}`, { reason: REASON });
  expect(res.statusCode, `${action}: ${res.body}`).toBe(expected.status);
  if (expected.code) expect(res.json().error.code).toBe(expected.code);
  await settled();
  expect(await snapshot(targetId), `${action} must change nothing`).toEqual(before);
  return before;
}

async function waitFor<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < 30; i += 1) {
    const found = await read();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

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
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: userIds } }] }, 'test-cleanup:admin-role-hierarchy').catch(() => 0);
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-role-hierarchy');
  await app.close();
});

describe('[DS110 #12] the role hierarchy governs every account-status action', () => {
  it('an ADMIN cannot ban the SUPER_ADMIN — refused, and the founder account is untouched', async () => {
    const admin = await makeAccount('ADMIN');
    const founder = await makeAccount('SUPER_ADMIN');

    const before = await expectRefusedUnchanged(admin, 'ban', founder.userId, { status: 403 });
    // Still signed in, still ACTIVE: no revocation, no retention scheduling, no notice.
    expect(before).toMatchObject({ status: 'ACTIVE', sessions: 1 });
  });

  it('an ADMIN cannot suspend the SUPER_ADMIN, a peer ADMIN, or themselves', async () => {
    const admin = await makeAccount('ADMIN');
    const peer = await makeAccount('ADMIN');
    const founder = await makeAccount('SUPER_ADMIN');

    await expectRefusedUnchanged(admin, 'suspend', founder.userId, { status: 403 });
    await expectRefusedUnchanged(admin, 'suspend', peer.userId, { status: 403 });
    await expectRefusedUnchanged(admin, 'ban', peer.userId, { status: 403 });
    await expectRefusedUnchanged(admin, 'suspend', admin.userId, { status: 403 });
    await expectRefusedUnchanged(admin, 'ban', admin.userId, { status: 403 });
  });

  it('a SUPER_ADMIN cannot act on another SUPER_ADMIN — who holds SUPER_ADMIN is a break-glass ceremony, not a console click', async () => {
    const founder = await makeAccount('SUPER_ADMIN');
    const second = await makeAccount('SUPER_ADMIN');

    await expectRefusedUnchanged(founder, 'ban', second.userId, { status: 403 });
    await expectRefusedUnchanged(founder, 'suspend', second.userId, { status: 403 });
    await expectRefusedUnchanged(founder, 'ban', founder.userId, { status: 403 });
  });

  it('ordinary work is untouched: an ADMIN suspends and restores a customer; a SUPER_ADMIN suspends an ADMIN and only a SUPER_ADMIN restores them', async () => {
    const admin = await makeAccount('ADMIN');
    const founder = await makeAccount('SUPER_ADMIN');
    const customer = await makeAccount('CUSTOMER');

    const suspended = await call(admin.token, 'PUT', `/api/v1/admin/users/${customer.userId}/suspend`, { reason: REASON });
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect((await snapshot(customer.userId)).status).toBe('SUSPENDED');
    const restored = await call(admin.token, 'PUT', `/api/v1/admin/users/${customer.userId}/unsuspend`, { reason: REASON });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await snapshot(customer.userId)).status).toBe('ACTIVE');

    // Down the hierarchy is allowed; sideways is not, in either direction.
    const target = await makeAccount('ADMIN');
    const bySuper = await call(founder.token, 'PUT', `/api/v1/admin/users/${target.userId}/suspend`, { reason: REASON });
    expect(bySuper.statusCode, bySuper.body).toBe(200);
    expect((await snapshot(target.userId)).status).toBe('SUSPENDED');
    await expectRefusedUnchanged(admin, 'unsuspend', target.userId, { status: 403 });
    const lifted = await call(founder.token, 'PUT', `/api/v1/admin/users/${target.userId}/unsuspend`, { reason: REASON });
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect((await snapshot(target.userId)).status).toBe('ACTIVE');
  });

  it('a ban is lifted only by a SUPER_ADMIN, only through /unban, and the unban is audited', async () => {
    const founder = await makeAccount('SUPER_ADMIN');
    const admin = await makeAccount('ADMIN');
    const victim = await makeAccount('CUSTOMER');

    // Authority is judged before state: an ADMIN's unban is refused as a
    // matter of role, whatever the account's status.
    await expectRefusedUnchanged(admin, 'unban', victim.userId, { status: 403 });

    const ban = await call(founder.token, 'PUT', `/api/v1/admin/users/${victim.userId}/ban`, { reason: REASON });
    expect(ban.statusCode, ban.body).toBe(200);
    expect(await snapshot(victim.userId)).toMatchObject({ status: 'BANNED', sessions: 0 });

    // An ADMIN cannot lift it — not through /unban, and not through /unsuspend.
    await expectRefusedUnchanged(admin, 'unban', victim.userId, { status: 403 });
    await expectRefusedUnchanged(admin, 'unsuspend', victim.userId, { status: 400, code: 'NOT_SUSPENDED' });
    // /unsuspend never lifts a ban, even for a SUPER_ADMIN: the routes stay distinct.
    await expectRefusedUnchanged(founder, 'unsuspend', victim.userId, { status: 400, code: 'NOT_SUSPENDED' });

    const unban = await call(founder.token, 'PUT', `/api/v1/admin/users/${victim.userId}/unban`, { reason: REASON });
    expect(unban.statusCode, unban.body).toBe(200);
    expect(unban.json().data.status).toBe('ACTIVE');
    expect((await snapshot(victim.userId)).status).toBe('ACTIVE');

    // The authority audit row names the act and where the account came from…
    const audit = await app.prisma.auditLog.findFirst({ where: { action: 'UNBAN_USER', entity: 'User', entityId: victim.userId } });
    expect(audit?.userId).toBe(founder.userId);
    expect((audit!.changes as { previousStatus: string }).previousStatus).toBe('BANNED');
    // …and the admin audit backstop recorded the route against the same account.
    const backstop = await waitFor(() => app.prisma.auditLog.findFirst({
      where: { userId: founder.userId, action: 'ADMIN PUT /api/v1/admin/users/:id/unban', entityId: victim.userId },
    }));
    expect(backstop, 'the ADMIN PUT /users/:id/unban backstop row').toBeTruthy();

    // A second unban of an ACTIVE account is a refused transition, not a silent no-op.
    await expectRefusedUnchanged(founder, 'unban', victim.userId, { status: 400, code: 'NOT_BANNED' });
  });
});
