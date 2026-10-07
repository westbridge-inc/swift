import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import { TripShareService, MAX_LIVE_SHARES_PER_TRIP } from '../modules/safety/trip-share.service';
import type { NotificationChannels } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [M062] Minting a trip-share link is bounded atomically: a person holds at
// most MAX_LIVE_SHARES_PER_TRIP live links for one trip however many taps
// race; a text is reserved (its minute and its budget) BEFORE any link is
// written, so a refused text leaves no orphaned link; and a mint that is
// refused after the reservation gives the budget back and texts nobody.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL']! } } });
const redis = new Redis(process.env['REDIS_URL']!);

const sent: Array<{ to: string; body: string }> = [];
const channels = { sms: { sendSms: async (to: string, body: string) => { sent.push({ to, body }); return { ref: 't' }; } } } as unknown as NotificationChannels;
const svc = new TripShareService(prisma, redis, channels);

const RUN = nanoid(6);
const userIds: string[] = []; const orderIds: string[] = []; const driverIds: string[] = [];
const phoneBase = 592_880_000_000 + Math.floor(Math.random() * 9_000_000);
let seq = 0;

async function mkTrip() {
  seq += 1;
  const customer = await prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Bound', lastName: `Share${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
  userIds.push(customer.id);
  const order = await prisma.order.create({
    data: {
      customerId: customer.id, orderType: 'TAXI', status: 'RIDE_IN_PROGRESS' as never, orderNumber: `TB-${nanoid(8)}`, fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8045, pickupLng: -58.1622, deliveryAddress: 'B', deliveryLat: 6.8145, deliveryLng: -58.1522,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  return { customer, order };
}
const liveLinks = (orderId: string) => prisma.tripShareToken.count({ where: { orderId, revokedAt: null, expiresAt: { gt: new Date() } } });
const recipientDayCount = async (phone: string) => {
  const keys = await redis.keys(`sms_safety_recipient_day:*:${phone}`);
  return keys.length ? Number(await redis.get(keys[0]!)) : 0;
};

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  redis.disconnect();
});

describe('[M062] the live-link allowance is atomic', () => {
  it(`racing mints never exceed ${MAX_LIVE_SHARES_PER_TRIP} live links for one trip`, async () => {
    const { customer, order } = await mkTrip();
    const results = await Promise.allSettled(Array.from({ length: MAX_LIVE_SHARES_PER_TRIP * 3 }, () => svc.mint(customer.id, order.id)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter((r) => r.status === 'rejected');
    expect(ok).toBe(MAX_LIVE_SHARES_PER_TRIP);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ statusCode: 429, code: 'TOO_MANY_SHARE_LINKS' });
    expect(await liveLinks(order.id)).toBe(MAX_LIVE_SHARES_PER_TRIP);
  });

  it('a stopped link frees its place', async () => {
    const { customer, order } = await mkTrip();
    const first = await svc.mint(customer.id, order.id);
    for (let i = 1; i < MAX_LIVE_SHARES_PER_TRIP; i += 1) await svc.mint(customer.id, order.id);
    await expect(svc.mint(customer.id, order.id)).rejects.toMatchObject({ code: 'TOO_MANY_SHARE_LINKS' });
    await svc.revoke(customer.id, first.token);
    await expect(svc.mint(customer.id, order.id)).resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe('[M062] the text is reserved before the link exists', () => {
  it('a text refused by its per-minute limit leaves no orphaned link', async () => {
    const { customer, order } = await mkTrip();
    const phone = `+5926${String(Date.now()).slice(-6)}`;
    await svc.mint(customer.id, order.id, { sendToPhone: phone });
    const before = await prisma.tripShareToken.count({ where: { orderId: order.id } });
    await expect(svc.mint(customer.id, order.id, { sendToPhone: phone })).rejects.toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(await prisma.tripShareToken.count({ where: { orderId: order.id } })).toBe(before);
  });

  it('a mint refused after the reservation gives the budget back and texts nobody', async () => {
    const { customer, order } = await mkTrip();
    for (let i = 0; i < MAX_LIVE_SHARES_PER_TRIP; i += 1) await svc.mint(customer.id, order.id);
    const phone = `+5927${String(Date.now()).slice(-6)}`;
    sent.length = 0;
    await expect(svc.mint(customer.id, order.id, { sendToPhone: phone })).rejects.toMatchObject({ code: 'TOO_MANY_SHARE_LINKS' });
    expect(sent.filter((m) => m.to === phone)).toHaveLength(0);
    expect(await recipientDayCount(phone)).toBe(0);
    expect(await liveLinks(order.id)).toBe(MAX_LIVE_SHARES_PER_TRIP);
  });
});

describe('[M053] the public trip page is never handed a photo it does not own', () => {
  it('a third-party or storage-key photo on the mover\'s record never reaches the public view', async () => {
    const { customer, order } = await mkTrip();
    seq += 1;
    const driverUser = await prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Deo', lastName: `Share${RUN}`, roles: ['DRIVER'], activeRole: 'DRIVER', isPhoneVerified: true } });
    userIds.push(driverUser.id);
    const driver = await prisma.driver.create({ data: {
      userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'Silver', licensePlate: `PAB ${Math.floor(1000 + Math.random() * 8999)}`,
      driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x', profilePhotoUrl: 'https://tracker.example/pixel.png', vehiclePhotoUrl: 'kyc/someone-else/licence.jpg',
    } });
    driverIds.push(driver.id);
    await prisma.order.update({ where: { id: order.id }, data: { driverId: driver.id } });
    const { token } = await svc.mint(customer.id, order.id);
    const view = await svc.publicView(token, new Date(), `caller-${RUN}`);
    expect(view?.driver).toMatchObject({ firstName: 'Deo', photoUrl: null, vehiclePhotoUrl: null });
    expect(view?.driver?.plate).toBe(driver.licensePlate);
  });
});
