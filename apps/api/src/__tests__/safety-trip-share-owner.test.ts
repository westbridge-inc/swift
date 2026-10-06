import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import { TripShareService } from '../modules/safety/trip-share.service';
import type { NotificationChannels } from '../../src/providers/notifications/channels';

// Trip Share (safety spec §6). The laws under test: the token is unguessable
// and grants ONLY the narrow public payload (no addresses, no phones, no ids,
// passenger FIRST NAME only); invalid/revoked/expired are one
// indistinguishable null; the share dies at trip end + grace; a stranger
// cannot mint for someone else's trip (404-by-absence).

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const redis = new Redis(process.env['REDIS_URL']!);

const sent: Array<{ to: string; body: string }> = [];
const channels = {
  sms: { sendSms: async (to: string, body: string) => { sent.push({ to, body }); return { ref: 't' }; } },
} as unknown as NotificationChannels;

const svc = new TripShareService(prisma, redis, channels);

const userIds: string[] = [];
const orderIds: string[] = [];
const driverIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_870_000_000 + Math.floor(Math.random() * 9_000_000);

async function mkUser(first: string, roles: ('CUSTOMER' | 'DRIVER')[] = ['CUSTOMER']) {
  seq += 1;
  const u = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: first, lastName: 'ShareTest', roles, activeRole: roles[0]!, isPhoneVerified: true },
  });
  userIds.push(u.id);
  return u;
}

async function mkTrip(opts: { status?: string; withDriver?: boolean } = {}) {
  const customer = await mkUser('Asha');
  let driverId: string | null = null;
  if (opts.withDriver !== false) {
    const driverUser = await mkUser('Deo', ['DRIVER']);
    const driver = await prisma.driver.create({
      data: {
        userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019,
        vehicleColor: 'Silver', licensePlate: `PAB ${Math.floor(1000 + Math.random() * 8999)}`,
        driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
        currentLat: 6.8013, currentLng: -58.1553, lastLocationUpdate: new Date(),
      },
    });
    driverIds.push(driver.id);
    driverId = driver.id;
  }
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      orderType: 'TAXI',
      status: (opts.status ?? 'RIDE_IN_PROGRESS') as never,
      orderNumber: `TS-${nanoid(8)}`,
      fulfillment: 'DELIVERY',
      pickupAddress: 'Stabroek Market', pickupLat: 6.8045, pickupLng: -58.1622,
      deliveryAddress: '123 Secret Street, Georgetown',
      deliveryLat: 6.8145, deliveryLng: -58.1522,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0,
      totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
      ...(driverId ? { driverId } : {}),
    },
  });
  orderIds.push(order.id);
  return { customer, order };
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  redis.disconnect();
});


 describe('MASTER-031 owner share control survives client state loss', () => {
  it('two links minted across driver change and client remount both stop without remembering secrets', async () => {
    const { customer, order } = await mkTrip({ status: 'PENDING', withDriver: false });
    const first = await svc.mint(customer.id, order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'DRIVER_ASSIGNED' } });
    const second = await svc.mint(customer.id, order.id);
    expect(await svc.publicView(first.token)).not.toBeNull();
    expect(await svc.publicView(second.token)).not.toBeNull();
    const remounted = new TripShareService(prisma, redis, channels);
    const controls = await remounted.listOwned(customer.id, order.id);
    expect(controls).toHaveLength(2);
    expect(JSON.stringify(controls)).not.toContain(first.token);
    await remounted.revokeAll(customer.id, order.id);
    expect(await svc.publicView(first.token)).toBeNull();
    expect(await svc.publicView(second.token)).toBeNull();
    expect(await remounted.listOwned(customer.id, order.id)).toEqual([]);
    await remounted.revokeAll(customer.id, order.id); // response-loss retry
  });
  it('a different owner cannot list or revoke another trip', async () => {
    const { customer, order } = await mkTrip();
    const stranger = await mkUser('Other');
    const link = await svc.mint(customer.id, order.id);
    await expect(svc.listOwned(stranger.id, order.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.revokeAll(stranger.id, order.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await svc.publicView(link.token)).not.toBeNull();
  });
});
