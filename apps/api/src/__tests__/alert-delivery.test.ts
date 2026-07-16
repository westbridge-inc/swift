import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { NotificationService, acknowledgeAlert } from '../modules/notification/notification.service';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// Alert-delivery tracking (alerts spec §A4): a row at send, a stamp at
// acknowledgment, and the health read that catches silent failures.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
const subjectIds: string[] = [];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  const admin = await loginWithOtp(app, '+5926001000');
  adminToken = admin.json().data.tokens.accessToken;
});

afterAll(async () => {
  if (subjectIds.length > 0) {
    await app.prisma.alertDelivery.deleteMany({ where: { subjectId: { in: subjectIds } } });
  }
  if (userIds.length > 0) {
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('send → ack → health', () => {
  it('newOrderForVendor writes a delivery row; acknowledgeAlert stamps it once', async () => {
    const vendorUser = await app.prisma.user.create({
      data: {
        phone: `+59256${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'Alert', lastName: 'Vendor',
        roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never,
        isPhoneVerified: true,
      },
    });
    userIds.push(vendorUser.id);
    const orderId = `alert-test-${nanoid(8)}`;
    subjectIds.push(orderId);

    const notifications = new NotificationService(app.prisma, app.io);
    await notifications.newOrderForVendor(vendorUser.id, 'SW-TEST-0001', 2, 3500, orderId);

    let row = await app.prisma.alertDelivery.findFirstOrThrow({
      where: { subjectId: orderId, recipientId: vendorUser.id },
    });
    expect(row.kind).toBe('VENDOR_ORDER');
    expect(row.acknowledgedAt).toBeNull();

    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', orderId);
    row = await app.prisma.alertDelivery.findFirstOrThrow({ where: { id: row.id } });
    expect(row.acknowledgedAt).not.toBeNull();
    const firstAck = row.acknowledgedAt!;

    // Idempotent: a second ack does not move the stamp.
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', orderId);
    row = await app.prisma.alertDelivery.findFirstOrThrow({ where: { id: row.id } });
    expect(row.acknowledgedAt!.getTime()).toBe(firstAck.getTime());
  });

  it('alerts/health reports ack rate, median time-to-ack, and breach flags', async () => {
    // Manufacture a controlled window: 3 sent, 2 acked (one fast, one slow).
    const mk = async (ackSecondsAgo: number | null, sentSecondsAgo: number) => {
      const subjectId = `alert-health-${nanoid(8)}`;
      subjectIds.push(subjectId);
      await app.prisma.alertDelivery.create({
        data: {
          kind: 'MOVER_OFFER',
          subjectId,
          recipientId: 'health-probe',
          sentAt: new Date(Date.now() - sentSecondsAgo * 1000),
          acknowledgedAt: ackSecondsAgo === null ? null : new Date(Date.now() - ackSecondsAgo * 1000),
        },
      });
    };
    await mk(55, 60); // acked in 5s
    await mk(10, 60); // acked in 50s (slow)
    await mk(null, 60); // never acked

    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/alerts/health?hours=1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const mover = (res.json().data.kinds as Array<any>).find((k) => k.kind === 'MOVER_OFFER');
    expect(mover).toBeTruthy();
    expect(mover.sent).toBeGreaterThanOrEqual(3);
    expect(mover.acked).toBeGreaterThanOrEqual(2);
    // 2/3 ≈ 0.67 < 0.9 → breaching (other suites' rows can only add unacked probes here)
    expect(mover.breaching).toBe(true);
  });
});
