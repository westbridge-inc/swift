import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import { TripShareService } from '../modules/safety/trip-share.service';
import type { NotificationChannels } from '../providers/notifications/channels';

// ---------------------------------------------------------------------------
// [L10 §2] The emergency line on the public trip page comes from the ONE
// server setting the phone dials from: the market's CountryConfig emergency
// policy. A verified police number is offered; an unverified or absent one is
// never shown as a number to call. No number is hard-coded.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL']! } } });
const redis = new Redis(process.env['REDIS_URL']!);
const svc = new TripShareService(prisma, redis, { sms: { sendSms: async () => ({ ref: 't' }) } } as unknown as NotificationChannels);
const RUN = nanoid(6);
const userIds: string[] = []; const orderIds: string[] = [];
const phoneBase = 592_890_000_000 + Math.floor(Math.random() * 9_000_000);
let seq = 0;
let market: { code: string; emergency: Prisma.JsonValue } | null = null;

async function sharedTrip() {
  seq += 1;
  const customer = await prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Line', lastName: `Share${RUN}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
  userIds.push(customer.id);
  const order = await prisma.order.create({ data: {
    customerId: customer.id, orderType: 'TAXI', status: 'RIDE_IN_PROGRESS' as never, orderNumber: `TE-${nanoid(8)}`, fulfillment: 'DELIVERY', currencyCode: 'GYD',
    pickupAddress: 'A', pickupLat: 6.8045, pickupLng: -58.1622, deliveryAddress: 'B', deliveryLat: 6.8145, deliveryLng: -58.1522,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
  } });
  orderIds.push(order.id);
  const { token } = await svc.mint(customer.id, order.id);
  return token;
}
const setPolicy = (emergency: Prisma.InputJsonValue | typeof Prisma.DbNull) => prisma.countryConfig.update({ where: { code: market!.code }, data: { emergency } });

beforeAll(async () => {
  market = await prisma.countryConfig.findFirst({ where: { currencyCode: 'GYD' }, orderBy: { code: 'asc' }, select: { code: true, emergency: true } });
  expect(market, 'the seeded launch market').not.toBeNull();
});
afterAll(async () => {
  if (market) await setPolicy(market.emergency === null ? Prisma.DbNull : (market.emergency as Prisma.InputJsonValue));
  await prisma.tripShareToken.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  redis.disconnect();
});

describe('[L10 §2] the public trip page\'s emergency line is the market setting', () => {
  it('a verified police number in the setting is the number the page offers', async () => {
    await setPolicy({ police: { number: '911', verified: true, verifiedAt: '2026-10-01T00:00:00.000Z', verifiedBy: 'synthetic-ops' } });
    const view = await svc.publicView(await sharedTrip(), new Date(), `caller-${RUN}-a`);
    expect(view).toMatchObject({ emergencyDial: '911' });
    expect(view!.emergencyNote).toContain('911');
  });

  it('a different verified number in the setting changes the page with it — nothing is hard-coded', async () => {
    await setPolicy({ police: { number: '9990', verified: true, verifiedAt: '2026-10-01T00:00:00.000Z' } });
    const view = await svc.publicView(await sharedTrip(), new Date(), `caller-${RUN}-b`);
    expect(view).toMatchObject({ emergencyDial: '9990' });
    expect(view!.emergencyNote).not.toMatch(/911|225-8196/);
  });

  it('an unverified or absent number is never offered as a number to call', async () => {
    await setPolicy({ police: { number: '911', verified: false } });
    const unverified = await svc.publicView(await sharedTrip(), new Date(), `caller-${RUN}-c`);
    expect(unverified).toMatchObject({ emergencyDial: null, emergencyNote: 'If something is wrong, call your local emergency number.' });
    await setPolicy(Prisma.DbNull);
    const absent = await svc.publicView(await sharedTrip(), new Date(), `caller-${RUN}-d`);
    expect(absent).toMatchObject({ emergencyDial: null });
    expect(absent!.emergencyNote).not.toMatch(/\d{3}/);
  });
});
