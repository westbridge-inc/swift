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
// Row 90. The admin suspend / unsuspend / ban / unban routes used to answer
// with the target's whole User row — password hash, phone, email and every
// other column. Each now answers with the account-status projection only.
// Fixture range: +59243nnnnn (this file only).
// ---------------------------------------------------------------------------

const STATUS_KEYS = ['activeRole', 'id', 'roles', 'status', 'updatedAt'];

let app: FastifyInstance;
const userIds: string[] = [];
const RUN = nanoid(6).toLowerCase();

async function makeAccount(role: 'SUPER_ADMIN' | 'CUSTOMER', extra: Record<string, unknown> = {}) {
  const phone = `+59243${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const privileged = role !== 'CUSTOMER';
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Shape', lastName: `${role.slice(0, 3)}${RUN}${userIds.length}`,
      roles: privileged ? [role, 'CUSTOMER'] : ['CUSTOMER'],
      activeRole: role, status: 'ACTIVE', isPhoneVerified: true,
      ...(privileged ? { admin: { create: { permissions: ['*'] } } } : {}),
      ...extra,
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'l05-admin-status', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { token, userId: user.id, phone };
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
    await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: userIds } }] }, 'test-cleanup:l05-admin-status').catch(() => 0);
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:l05-admin-status');
  await app.close();
});

describe('[row 90] account-status routes answer with a safe projection', () => {
  it('suspend, unsuspend, ban and unban each return only id, status, roles, activeRole and updatedAt', async () => {
    const boss = await makeAccount('SUPER_ADMIN');
    const email = `shape-${RUN}@example.invalid`;
    const passwordHash = `$argon2id$v=19$m=65536,t=3,p=4$${nanoid(22)}$${nanoid(43)}`;
    const target = await makeAccount('CUSTOMER', { email, passwordHash });

    const steps: Array<['suspend' | 'unsuspend' | 'ban' | 'unban', string]> = [
      ['suspend', 'SUSPENDED'], ['unsuspend', 'ACTIVE'], ['ban', 'BANNED'], ['unban', 'ACTIVE'],
    ];
    for (const [action, status] of steps) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/admin/users/${target.userId}/${action}`,
        payload: { reason: 'Shape check of the account-status answer for this route' },
        headers: { authorization: `Bearer ${boss.token}`, 'content-type': 'application/json' },
      });
      expect(res.statusCode, `${action}: ${res.body}`).toBe(200);
      const data = res.json().data as Record<string, unknown>;
      expect(Object.keys(data).sort(), action).toEqual(STATUS_KEYS);
      expect(data['id']).toBe(target.userId);
      expect(data['status']).toBe(status);
      for (const secret of [target.phone, email, passwordHash, 'passwordHash', '"phone"', '"email"']) {
        expect(res.body, `${action} leaks ${secret}`).not.toContain(secret);
      }
    }
  });
});
