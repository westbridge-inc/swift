import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import { randomBytes } from 'node:crypto';
import { NotificationService } from '../modules/notification/notification.service';
import { TripShareService, notifyTripShareGuardians, tripShareDigest } from '../modules/safety/trip-share.service';
import type { NotificationChannels } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [L10 §2 · coordinator ruling 5 Oct 2026] When the monitoring a rider gave
// someone ends, a guardian who is a signed-in Swift user is told how, in the
// app: the rider stopped sharing, the trip was completed or cancelled, or the
// link ran out before Swift saw the trip finish. Once per link. Nobody else
// is told anything, a legacy link Swift reset is never reported as the
// rider's choice, and the public link itself still answers a stopped share
// exactly like an unknown one.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL']! } } });
const redis = new Redis(process.env['REDIS_URL']!);
const io = { to: () => ({ emit: () => {} }) } as never;
const notifications = new NotificationService(prisma, io);
const svc = new TripShareService(prisma, redis, { sms: { sendSms: async () => ({ ref: 't' }) } } as unknown as NotificationChannels);
const RUN = nanoid(6);
const userIds: string[] = []; const orderIds: string[] = [];
const phoneBase = 592_610_000_000 + Math.floor(Math.random() * 9_000_000);
let seq = 0;

async function user(firstName: string, opts: { verified?: boolean } = {}) {
  seq += 1;
  const u = await prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName, lastName: `G${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: opts.verified ?? true, status: 'ACTIVE' } });
  userIds.push(u.id);
  return u;
}

async function sharedTrip(guardianPhone: string, opts: { status?: string; expired?: boolean; rotated?: boolean } = {}) {
  const rider = await user('Asha');
  const order = await prisma.order.create({ data: {
    customerId: rider.id, orderType: 'TAXI', status: (opts.status ?? 'RIDE_IN_PROGRESS') as never, orderNumber: `TG-${nanoid(8)}`, fulfillment: 'DELIVERY',
    pickupAddress: 'A', pickupLat: 6.8045, pickupLng: -58.1622, deliveryAddress: 'B', deliveryLat: 6.8145, deliveryLng: -58.1522,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
    ...(opts.status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
  } });
  orderIds.push(order.id);
  const secret = randomBytes(32).toString('base64url');
  const share = await prisma.tripShareToken.create({ data: {
    orderId: order.id, createdByUserId: rider.id, tokenDigest: tripShareDigest(secret), tokenPrefix: secret.slice(0, 6), sharedToPhone: guardianPhone,
    expiresAt: new Date(Date.now() + (opts.expired ? -60_000 : 3_600_000)),
    ...(opts.rotated ? { rotatedAt: new Date(), revokedAt: new Date() } : {}),
  } });
  return { rider, order, share, secret };
}

const noticesFor = (userId: string) => prisma.notification.findMany({ where: { userId, data: { path: ['kind'], equals: 'trip_share_ended' } } });

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  redis.disconnect();
});

describe('[L10 §2] a guardian who uses Swift is told how the monitoring ended', () => {
  it('the rider stopped sharing: told once, and the public link still reads like an unknown one', async () => {
    const guardian = await user('Gita');
    const { rider, secret } = await sharedTrip(guardian.phone);
    await svc.revoke(rider.id, secret);
    await notifyTripShareGuardians(prisma, notifications);
    await notifyTripShareGuardians(prisma, notifications);
    const notices = await noticesFor(guardian.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toBe('Asha stopped sharing their trip');
    expect(notices[0]!.data).toMatchObject({ kind: 'trip_share_ended', outcome: 'STOPPED_BY_RIDER' });
    expect(notices[0]!.data).not.toHaveProperty('orderId');
    expect(await svc.publicView(secret, new Date(), `caller-${RUN}-1`)).toBeNull();
  });

  it('the trip was completed', async () => {
    const guardian = await user('Gita');
    await sharedTrip(guardian.phone, { status: 'DELIVERED' });
    await notifyTripShareGuardians(prisma, notifications);
    const [notice] = await noticesFor(guardian.id);
    expect(notice?.title).toBe("Asha's trip was completed");
    expect(notice?.data).toMatchObject({ outcome: 'COMPLETED' });
  });

  it('the trip was cancelled', async () => {
    const guardian = await user('Gita');
    await sharedTrip(guardian.phone, { status: 'CANCELLED' });
    await notifyTripShareGuardians(prisma, notifications);
    expect((await noticesFor(guardian.id))[0]?.data).toMatchObject({ outcome: 'CANCELLED' });
  });

  it('the link ran out before Swift saw the trip finish: contact lost, check on them', async () => {
    const guardian = await user('Gita');
    await sharedTrip(guardian.phone, { expired: true });
    await notifyTripShareGuardians(prisma, notifications);
    const [notice] = await noticesFor(guardian.id);
    expect(notice?.data).toMatchObject({ outcome: 'LOST_CONTACT' });
    expect(notice?.body).toContain('Contact Asha directly');
  });

  it('a live trip tells nobody anything yet', async () => {
    const guardian = await user('Gita');
    await sharedTrip(guardian.phone);
    await notifyTripShareGuardians(prisma, notifications);
    expect(await noticesFor(guardian.id)).toHaveLength(0);
  });

  it('a number that is not a verified Swift user is never notified, and a link Swift reset is not the rider\'s choice', async () => {
    const unverified = await user('Gita', { verified: false });
    const { rider, secret } = await sharedTrip(unverified.phone);
    await svc.revoke(rider.id, secret);
    const guardian = await user('Gita');
    await sharedTrip(guardian.phone, { rotated: true });
    await notifyTripShareGuardians(prisma, notifications);
    expect(await noticesFor(unverified.id)).toHaveLength(0);
    expect(await noticesFor(guardian.id)).toHaveLength(0);
  });
});
