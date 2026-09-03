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
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [ADM-007] AN ADMIN COULD READ ANYONE AND LEAVE NOTHING BEHIND.
//
// Two of the seventy-seven admin reads were logged: the identity graph and the
// appeals queue. Every other one — open a customer, a driver, an order, an
// uploaded document, a live location, a handover secret — left no record at
// all. That defeats the "every access is logged" commitment this platform
// makes to the people whose data it holds (Appendix AH, AH-DPA-003), and it
// means an investigation into misuse has nothing to investigate.
//
// The C1 class is the set that discloses identity, location, a document or a
// secret. It is now the set that writes an access record: who looked, at what,
// under which capability, and why — and the record cannot be edited afterwards
// by the person who left it.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = nanoid(6).toLowerCase();
const userIds: string[] = [];
let token = '';

const call = (method: string, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: method as never, url, headers: { authorization: `Bearer ${token}`, ...headers } });

const reads = (action?: string) =>
  app.prisma.sensitiveReadLog.findMany({
    where: { actorUserId: userIds[0]!, ...(action ? { action } : {}) },
    orderBy: { at: 'desc' },
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
  const phone = `+59272${String(Math.floor(Math.random() * 90000) + 10000)}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: 'Reader', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN',
      status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } },
    },
  });
  userIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: 'admin-sensitive-read', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});
afterAll(async () => {
  await runWithoutTenant(async () => {
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-sensitive-read').catch(() => 0);
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-sensitive-read').catch(() => 0);
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test-cleanup:admin-sensitive-read');
  await app.close();
});

describe('[ADM-007] looking at a person leaves a record', () => {
  it('opening the customer list is recorded — actor, action, capability and purpose', async () => {
    const res = await call('GET', '/api/v1/admin/users?limit=1');
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await reads('GET /users');
    expect(row, 'a record for the read').toBeTruthy();
    expect(row!.actorUserId).toBe(userIds[0]);
    expect(row!.capability).toBe('user.read');
    expect(row!.purpose).toBe('GET /users');
    expect(row!.subjectId).toBeNull(); // a list read names no one subject
  });

  it('opening ONE person names them as the subject', async () => {
    const subject = await app.prisma.user.findFirstOrThrow({ where: { id: userIds[0] } });
    const res = await call('GET', `/api/v1/admin/users/${subject.id}`);
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await reads('GET /users/:id');
    expect(row).toBeTruthy();
    expect(row!.subjectId).toBe(subject.id);
  });

  it('a read that DISCLOSED NOTHING is not recorded — a 404 is not an access', async () => {
    const before = (await reads('GET /users/:id')).length;
    const res = await call('GET', '/api/v1/admin/users/no-such-person');
    expect(res.statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 200));
    expect((await reads('GET /users/:id')).length).toBe(before);
  });

  it('an ordinary operational read is NOT recorded — logging a dashboard count buries the reads that matter', async () => {
    const before = (await reads()).length;
    expect((await call('GET', '/api/v1/admin/dashboard/overview')).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/admin/vendors')).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await reads()).length).toBe(before);
  });

  it('a stated reason becomes the purpose, where the route asks for one', async () => {
    const res = await call('GET', '/api/v1/admin/orders?limit=1', { 'x-swift-reason': 'Fraud review case 4182, customer complaint' });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await reads('GET /orders');
    expect(row!.purpose).toBe('Fraud review case 4182, customer complaint');
  });
});

describe('[ADM-007] the record cannot be edited by the person who left it', () => {
  it('an access row is append-only at the database', async () => {
    await call('GET', '/api/v1/admin/users?limit=1');
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await reads('GET /users');
    expect(row).toBeTruthy();
    await expect(app.prisma.sensitiveReadLog.update({ where: { id: row!.id }, data: { purpose: 'something else' } }))
      .rejects.toThrow(/append-only/);
    await expect(app.prisma.sensitiveReadLog.delete({ where: { id: row!.id } })).rejects.toThrow(/append-only/);
    const after = await app.prisma.sensitiveReadLog.findUniqueOrThrow({ where: { id: row!.id } });
    expect(after.purpose).toBe(row!.purpose);
  });

  it('retention goes through the same named purge the audit trail uses', async () => {
    await call('GET', '/api/v1/admin/users?limit=1');
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await reads('GET /users');
    const removed = await purgeSensitiveReadLogs(app.prisma, { id: row!.id }, 'retention:adm007-suite');
    expect(removed).toBe(1);
    await expect(purgeSensitiveReadLogs(app.prisma, { id: 'x' }, 'no')).rejects.toThrow(/must name its reason/);
  });
});

describe('[ADM-007] the law itself', () => {
  it('the C1 set is what the appendix says it is — identity, location, documents, secrets', () => {
    const c1 = Object.entries(ADMIN_ROUTE_AUTHORITY).filter(([, a]) => a.cls === 'C1').map(([key]) => key);
    expect(c1.length).toBeGreaterThan(20);
    for (const key of [
      'GET /users/:id', 'GET /riders/:id', 'GET /drivers/:id', 'GET /orders/:id',
      'GET /orders/:id/handover-secret', 'GET /orders/:id/customer-identity',
      'GET /verification/:id/document-url', 'GET /integrity/identity/:userId',
      'GET /ops/live', 'GET /audit-logs', 'GET /support',
    ]) {
      expect(c1, key).toContain(key);
    }
    // and a plain operational list is NOT in it
    expect(c1).not.toContain('GET /dashboard/overview');
    expect(c1).not.toContain('GET /vendors');
  });

  it('the two reads that were already audited are still audited — nothing was traded away', () => {
    for (const key of ['GET /integrity/identity/:userId', 'GET /integrity/appeals']) {
      expect(ADMIN_ROUTE_AUTHORITY[key]!.cls).toBe('C1');
    }
  });
});
