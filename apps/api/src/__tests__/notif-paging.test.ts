import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { prismaPlugin, runWithTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { withPushRetry, type PushProvider } from '../providers/notifications/channels';
import { NotificationService, notifyAdmins } from '../modules/notification/notification.service';
import { opsPageOnce } from '../jobs/queue';

// ---------------------------------------------------------------------------
// SWIFT-UG-NOTIF-01/02 + SWIFT-AUD-D7-02/03 — notification hardening and ops
// paging: bounded push retry, template guard, ADMIN_OPS ack-tracking, and the
// dedup primitive every pager rides on.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminUserId: string;

const ioStub = { to: () => ({ emit: () => {} }) } as unknown as Server;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();

  const admin = await app.prisma.user.create({
    data: {
      phone: '+5920079301', firstName: 'Ops', lastName: 'Admin',
      roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true,
    },
  });
  adminUserId = admin.id;
});

afterAll(async () => {
  if (adminUserId) {
    await app.prisma.alertDelivery.deleteMany({ where: { recipientId: adminUserId } });
    await app.prisma.notification.deleteMany({ where: { userId: adminUserId } });
    await app.prisma.user.deleteMany({ where: { id: adminUserId } });
  }
  await app.redis.del('ops_page:test-dedupe');
  await app.redis.del('ops_page:test-dedupe-fail');
  await app.close();
});

describe('withPushRetry [SWIFT-UG-NOTIF-01]', () => {
  function flaky(failures: number) {
    let calls = 0;
    const provider: PushProvider = {
      async sendPush() {
        calls += 1;
        if (calls <= failures) throw new Error(`transient ${calls}`);
        return { sent: 1 };
      },
    };
    return { provider, calls: () => calls };
  }

  it('a transient double-failure still delivers on the third attempt', async () => {
    const { provider, calls } = flaky(2);
    const res = await withPushRetry(provider, [1, 1]).sendPush(['t'], 'T', 'B');
    expect(res.sent).toBe(1);
    expect(calls()).toBe(3);
  });

  it('a persistent failure exhausts the retries and rethrows to the caller', async () => {
    const { provider, calls } = flaky(99);
    await expect(withPushRetry(provider, [1, 1]).sendPush(['t'], 'T', 'B')).rejects.toThrow('transient 3');
    expect(calls()).toBe(3); // bounded — never an infinite loop
  });
});

describe('template guard [SWIFT-UG-NOTIF-02]', () => {
  it('a missing/NaN ETA never renders into the customer copy', async () => {
    const svc = new NotificationService(app.prisma, ioStub);
    await svc.orderPickedUp(adminUserId, 'SW-TEST-01', 'Testy Rider', 'order-x', Number.NaN);
    const row = await app.prisma.notification.findFirst({
      where: { userId: adminUserId, title: 'On Its Way!' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).toBeTruthy();
    expect(row!.body).not.toMatch(/NaN|undefined/);
    expect(row!.body).toContain('picked up your order SW-TEST-01');
  });
});

describe('notifyAdmins tenancy [NOC-A F45]', () => {
  it('a tenant-scoped page reaches that tenant\'s admins and NOT another tenant\'s', async () => {
    const svc = new NotificationService(app.prisma, ioStub);
    const otherTenant = `noc-t-${Math.random().toString(36).slice(2, 8)}`;
    await app.prisma.tenant.create({ data: { id: otherTenant, name: 'Other', slug: otherTenant, isActive: true } });
    const foreignAdmin = await app.prisma.user.create({
      data: {
        phone: `+59278${Math.floor(Math.random() * 900000) + 100000}`,
        firstName: 'Foreign', lastName: 'Admin',
        roles: ['ADMIN'] as never[], activeRole: 'ADMIN' as never,
        isPhoneVerified: true, status: 'ACTIVE', tenantId: otherTenant,
      },
    });
    try {
      await notifyAdmins(app.prisma, svc, {
        tenantId: 'swift-default',
        title: 'Scoped page',
        body: 'Only the default tenant should see this.',
        data: { kind: 'ops_tenancy_probe' },
      });
      const leaked = await app.prisma.notification.count({
        where: { userId: foreignAdmin.id, data: { path: ['kind'], equals: 'ops_tenancy_probe' } as never },
      });
      expect(leaked, "a foreign tenant's admin was paged").toBe(0);

      // [F-027-20] ...and an explicit platform-wide page reaches PLATFORM
      // OPERATORS, not every tenant's admins.
      //
      // This assertion used to be the opposite, and that is what made the
      // finding possible: `null` meant "drop every tenant predicate", so
      // twelve callers that chose it — collusion pairs, billing invariant
      // reports with subscription ids and balances, incident patterns with
      // subject ids — disclosed one operator's data to all the others. A
      // required parameter does not help when the wrong answer is still
      // catastrophic. Now the wrong answer under-notifies instead.
      await notifyAdmins(app.prisma, svc, {
        tenantId: null,
        title: 'Platform page',
        body: 'Platform operators should see this.',
        data: { kind: 'ops_tenancy_probe_global' },
      });
      const leakedGlobal = await app.prisma.notification.count({
        where: { userId: foreignAdmin.id, data: { path: ['kind'], equals: 'ops_tenancy_probe_global' } as never },
      });
      expect(leakedGlobal, "a platform page must NOT reach an ordinary tenant's admin").toBe(0);

      const superAdmin = await app.prisma.user.create({
        data: {
          phone: `+59280${Math.floor(Math.random() * 900000) + 100000}`,
          firstName: 'Platform', lastName: 'Operator',
          roles: ['SUPER_ADMIN'] as never[], activeRole: 'SUPER_ADMIN' as never,
          isPhoneVerified: true, status: 'ACTIVE', tenantId: otherTenant,
        },
      });
      try {
        await notifyAdmins(app.prisma, svc, {
          tenantId: null,
          title: 'Platform page 2',
          body: 'Platform operators should see this.',
          data: { kind: 'ops_tenancy_probe_super' },
        });
        const reached = await app.prisma.notification.count({
          where: { userId: superAdmin.id, data: { path: ['kind'], equals: 'ops_tenancy_probe_super' } as never },
        });
        expect(reached, 'a platform page must reach a platform operator').toBeGreaterThanOrEqual(1);
      } finally {
        await app.prisma.notification.deleteMany({ where: { userId: superAdmin.id } });
        await app.prisma.alertDelivery.deleteMany({ where: { recipientId: superAdmin.id } });
        await app.prisma.user.delete({ where: { id: superAdmin.id } });
      }
    } finally {
      await app.prisma.notification.deleteMany({ where: { userId: foreignAdmin.id } });
      await app.prisma.alertDelivery.deleteMany({ where: { recipientId: foreignAdmin.id } });
      await app.prisma.user.delete({ where: { id: foreignAdmin.id } });
      await app.prisma.tenant.delete({ where: { id: otherTenant } });
    }
  });
});

describe('notifyAdmins under request tenant scope [F-028-10]', () => {
  it('a platform page fired INSIDE a tenant request still reaches platform operators', async () => {
    // `User` is an ALS-scoped model, so this lookup used to be silently
    // intersected with the CALLER's tenant: notifyAdmins(null) inside an
    // ordinary tenant-A request found only super-admins who themselves live
    // in tenant A — in the ordinary deployment shape, ZERO. The 5xx-spike
    // pager then counted the empty page as success and its 15-minute dedup
    // window kept the outage dark. Paging operators is a sanctioned
    // cross-tenant read; it must not depend on whose request it runs inside.
    const svc = new NotificationService(app.prisma, ioStub);
    const opsTenant = `f02810-${Math.random().toString(36).slice(2, 8)}`;
    await app.prisma.tenant.create({ data: { id: opsTenant, name: 'Ops home', slug: opsTenant, isActive: false } });
    const operator = await app.prisma.user.create({
      data: {
        phone: `+59281${Math.floor(Math.random() * 900000) + 100000}`,
        firstName: 'Outage', lastName: 'Operator',
        roles: ['SUPER_ADMIN'] as never[], activeRole: 'SUPER_ADMIN' as never,
        isPhoneVerified: true, status: 'ACTIVE', tenantId: opsTenant,
      },
    });
    try {
      // The reproduction: the caller's request context is a DIFFERENT tenant.
      const paged = await runWithTenant('swift-default', () =>
        notifyAdmins(app.prisma, svc, {
          tenantId: null,
          title: 'Server error spike',
          body: 'probe',
          data: { kind: 'f02810_probe' },
        }));
      expect(paged, 'the platform operator outside the request tenant was not paged').toBeGreaterThanOrEqual(1);
      const row = await app.prisma.notification.count({
        where: { userId: operator.id, data: { path: ['kind'], equals: 'f02810_probe' } as never },
      });
      expect(row).toBe(1);
    } finally {
      await app.prisma.notification.deleteMany({ where: { userId: operator.id } });
      await app.prisma.user.delete({ where: { id: operator.id } });
      await app.prisma.tenant.delete({ where: { id: opsTenant } });
    }
  });
});

describe('notifyAdmins ack-tracking [SWIFT-AUD-D7-03]', () => {
  it('an ops page lands in alert_deliveries as ADMIN_OPS with the condition as subject', async () => {
    const svc = new NotificationService(app.prisma, ioStub);
    // [F-027-20] Scoped to this admin's own tenant. It used to pass `null`,
    // which reached every admin everywhere; now `null` means platform
    // operators only, and this fixture is an ordinary ADMIN — so a null page
    // would (correctly) not reach them and the ack-tracking claim would be
    // proven on the wrong delivery.
    const admin = await app.prisma.user.findUniqueOrThrow({ where: { id: adminUserId }, select: { tenantId: true } });
    const notified = await notifyAdmins(app.prisma, svc, {
      tenantId: admin.tenantId,
      title: 'Test ops page',
      body: 'Something needs eyes.',
      data: { kind: 'ops_test_condition' },
    });
    expect(notified).toBeGreaterThanOrEqual(1);

    const rows = await app.prisma.alertDelivery.findMany({
      where: { recipientId: adminUserId, kind: 'ADMIN_OPS', subjectId: 'ops_test_condition' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.acknowledgedAt).toBeNull(); // /alerts/health can now see it
  });
});

describe('opsPageOnce dedup [SWIFT-AUD-D7-02]', () => {
  it('one page per condition per window — the second caller is a no-op', async () => {
    let fired = 0;
    const page = async () => {
      fired += 1;
    };
    const first = await opsPageOnce({ redis: app.redis }, 'test-dedupe', 60, page);
    const second = await opsPageOnce({ redis: app.redis }, 'test-dedupe', 60, page);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(fired).toBe(1);
  });

  it('a FAILED page releases the dedup key so the next detection re-pages — no silent suppression', async () => {
    let fired = 0;
    const failing = async () => { fired += 1; throw new Error('notify down'); };
    const ok = async () => { fired += 1; };
    // The page throws — the claim must NOT be left set, or this condition stays
    // un-paged for the whole window with no admin ever reached (the exact bug on
    // billing-failure / dead-worker-fleet alerts).
    const first = await opsPageOnce({ redis: app.redis }, 'test-dedupe-fail', 60, failing);
    expect(first).toBe(false);
    // The key was released, so the very next detection actually re-pages and lands.
    const second = await opsPageOnce({ redis: app.redis }, 'test-dedupe-fail', 60, ok);
    expect(second).toBe(true);
    expect(fired).toBe(2); // both attempts ran — the failure did not suppress paging
  });
});
