import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { prismaPlugin } from '../plugins/prisma';
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

describe('notifyAdmins ack-tracking [SWIFT-AUD-D7-03]', () => {
  it('an ops page lands in alert_deliveries as ADMIN_OPS with the condition as subject', async () => {
    const svc = new NotificationService(app.prisma, ioStub);
    const notified = await notifyAdmins(app.prisma, svc, {
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
