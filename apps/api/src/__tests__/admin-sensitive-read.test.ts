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
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

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
const RUN = wordFreeTag(8);
const userIds: string[] = [];
let token = '';

const call = (method: string, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: method as never, url, headers: { authorization: `Bearer ${token}`, ...headers } });

const reads = (action?: string) =>
  app.prisma.sensitiveReadLog.findMany({
    where: { actorUserId: userIds[0]!, ...(action ? { action } : {}) },
    orderBy: { at: 'desc' },
  });

// The access record is written by the admin plugin's onResponse hook, which
// runs AFTER inject() has resolved. A fixed sleep loses that race on a loaded
// runner (CI #2029 shard 2/4: "expected undefined to be truthy"), and a late
// row then lands inside the NEXT test. So wait for the row itself — bounded —
// and count only the rows the read under test added.
const readsAfter = async (action: string, before: number) => {
  const deadline = Date.now() + 10_000;
  let rows = await reads(action);
  while (rows.length <= before && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = await reads(action);
  }
  return rows;
};

// Absence needs a clock that is not a guess: a RECORDED read made after the
// read under test, waited for until its row has landed. Only then is "no new
// row" evidence rather than impatience.
const recordedSentinelRead = async () => {
  const before = (await reads('GET /users')).length;
  expect((await call('GET', '/api/v1/admin/users?limit=1')).statusCode).toBe(200);
  expect((await readsAfter('GET /users', before)).length, 'the sentinel read was recorded').toBe(before + 1);
};

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
  const phone = testPhone();
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
    const before = (await reads('GET /users')).length;
    const res = await call('GET', '/api/v1/admin/users?limit=1');
    expect(res.statusCode).toBe(200);
    const [row] = await readsAfter('GET /users', before);
    expect(row, 'a record for the read').toBeTruthy();
    expect(row!.actorUserId).toBe(userIds[0]);
    expect(row!.capability).toBe('user.read');
    expect(row!.purpose).toBe('GET /users');
    expect(row!.subjectId).toBeNull(); // a list read names no one subject
  });

  it('opening ONE person names them as the subject', async () => {
    const subject = await app.prisma.user.findFirstOrThrow({ where: { id: userIds[0] } });
    const before = (await reads('GET /users/:id')).length;
    const res = await call('GET', `/api/v1/admin/users/${subject.id}`);
    expect(res.statusCode).toBe(200);
    const [row] = await readsAfter('GET /users/:id', before);
    expect(row).toBeTruthy();
    expect(row!.subjectId).toBe(subject.id);
  });

  it('a read that DISCLOSED NOTHING is not recorded — a 404 is not an access', async () => {
    const before = (await reads('GET /users/:id')).length;
    const res = await call('GET', '/api/v1/admin/users/no-such-person');
    expect(res.statusCode).toBe(404);
    await recordedSentinelRead();
    expect((await reads('GET /users/:id')).length).toBe(before);
  });

  it('an ordinary operational read is NOT recorded — logging a dashboard count buries the reads that matter', async () => {
    const before = (await reads()).length;
    expect((await call('GET', '/api/v1/admin/dashboard/overview')).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/admin/vendors')).statusCode).toBe(200);
    await recordedSentinelRead();
    expect((await reads()).length, 'only the sentinel read added a row').toBe(before + 1);
  });

  it('a stated reason becomes the purpose, where the route asks for one', async () => {
    const before = (await reads('GET /orders')).length;
    const res = await call('GET', '/api/v1/admin/orders?limit=1', { 'x-swift-reason': 'Fraud review case 4182, customer complaint' });
    expect(res.statusCode).toBe(200);
    const [row] = await readsAfter('GET /orders', before);
    expect(row, 'a record for the read').toBeTruthy();
    expect(row!.purpose).toBe('Fraud review case 4182, customer complaint');
  });
});

describe('[ADM-007] the record cannot be edited by the person who left it', () => {
  it('an access row is append-only at the database', async () => {
    const before = (await reads('GET /users')).length;
    await call('GET', '/api/v1/admin/users?limit=1');
    const [row] = await readsAfter('GET /users', before);
    expect(row).toBeTruthy();
    await expect(app.prisma.sensitiveReadLog.update({ where: { id: row!.id }, data: { purpose: 'something else' } }))
      .rejects.toThrow(/append-only/);
    await expect(app.prisma.sensitiveReadLog.delete({ where: { id: row!.id } })).rejects.toThrow(/append-only/);
    const after = await app.prisma.sensitiveReadLog.findUniqueOrThrow({ where: { id: row!.id } });
    expect(after.purpose).toBe(row!.purpose);
  });

  it('retention goes through the same named purge the audit trail uses', async () => {
    const before = (await reads('GET /users')).length;
    await call('GET', '/api/v1/admin/users?limit=1');
    const [row] = await readsAfter('GET /users', before);
    expect(row, 'a record for the read').toBeTruthy();
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

// ---------------------------------------------------------------------------
// [S1 response-shaping] `GET /users/:id` used to return the row wholesale:
// the bcrypt hash, the lockout counters, the last GPS, the mover's KYC
// document URLs and the vendor owner's operational phone/email. The route is
// an allow-list now; this test fails on main on the very first assertion.
// ---------------------------------------------------------------------------

describe('[S1 response-shaping] GET /users/:id discloses no credential or location material', () => {
  it('returns no password hash, GPS, lockout state, KYC URLs or store contact', async () => {
    const phone = testPhone();
    const subject = await app.prisma.user.create({
      data: {
        phone, firstName: 'Subject', lastName: `Redact${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
        status: 'ACTIVE', isPhoneVerified: true,
        passwordHash: 'x',
        failedLoginAttempts: 3, lockedUntil: new Date(Date.now() + 60_000),
        lastKnownLat: 6.8, lastKnownLng: -58.15,
      },
    });
    userIds.push(subject.id);
    try {
      await app.prisma.rider.create({
        data: {
          userId: subject.id, riderType: 'DELIVERY', vehicleType: 'BICYCLE',
          documentsVerified: true, vehicleColor: 'red',
          nationalIdUrl: 'kyc/rider-national-id.jpg',
          driverLicenseUrl: 'kyc/rider-license.jpg',
          vehicleInsuranceUrl: 'kyc/rider-insurance.jpg',
        },
      });
      const vo = await app.prisma.vendorOwner.create({ data: { userId: subject.id } });
      await app.prisma.vendor.create({
        data: {
          ownerId: vo.id, name: `Redact Store ${RUN}`, slug: `redact-store-${RUN}`,
          vendorType: 'STORE', phone: '+59277219999', email: 'redact-owner@example.test',
          addressLine1: '1 Redact Way', city: 'Georgetown', region: 'Demerara-Mahaica',
          latitude: 6.8, longitude: -58.15,
          status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
        },
      });

      const res = await call('GET', `/api/v1/admin/users/${subject.id}`);
      expect(res.statusCode).toBe(200);
      const raw = JSON.stringify(res.json());
      for (const forbidden of [
        'passwordHash', 'failedLoginAttempts', 'lockedUntil', 'lastKnownLat', 'lastKnownLng',
        'nationalIdUrl', 'driverLicenseUrl', 'vehicleInsuranceUrl',
        '+59277219999', 'redact-owner@example.test',
      ]) {
        expect(raw, `the payload must not contain ${forbidden}`).not.toContain(forbidden);
      }
      // The console still gets the fields it draws from this envelope.
      const data = res.json().data;
      expect(data.rider.documentsVerified).toBe(true);
      expect(data.rider.vehicleColor).toBe('red');
      expect(data.vendorOwner.vendors[0].name).toBe(`Redact Store ${RUN}`);
      expect(data.vendorOwner.vendors[0].city).toBe('Georgetown');
    } finally {
      // Cascade the child rows now; the global teardown removes the user (and
      // would cascade these anyway — this keeps a failed assertion tidy).
      await runWithoutTenant(async () => {
        await app.prisma.vendor.deleteMany({ where: { owner: { userId: subject.id } } }).catch(() => {});
        await app.prisma.vendorOwner.deleteMany({ where: { userId: subject.id } }).catch(() => {});
        await app.prisma.rider.deleteMany({ where: { userId: subject.id } }).catch(() => {});
      }, 'test-cleanup:admin-sensitive-read');
    }
  });
});
