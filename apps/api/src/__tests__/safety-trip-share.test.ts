import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { nanoid } from 'nanoid';
import { TripShareService, tripShareDigest } from '../modules/safety/trip-share.service';
import type { NotificationChannels } from '../../src/providers/notifications/channels';

// Trip Share (safety spec §6). The laws under test: the token is unguessable
// and grants ONLY the narrow public payload (no addresses, no phones, no ids,
// passenger FIRST NAME only); invalid/revoked/expired are one
// indistinguishable null; the share dies at trip end + grace; a stranger
// cannot mint for someone else's trip (404-by-absence).

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const redis = new Redis(process.env['REDIS_URL'] || 'redis://localhost:6382', { db: 15 });

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

describe('§6 mint', () => {
  it('the passenger mints an unguessable token; strangers get 404-by-absence', async () => {
    const { customer, order } = await mkTrip();
    const share = await svc.mint(customer.id, order.id);
    expect(share.token.length).toBeGreaterThanOrEqual(43); // [S-16] 32 bytes base64url
    expect(share.url).toContain(`/trip/${share.token}`);

    const stranger = await mkUser('Nosy');
    await expect(svc.mint(stranger.id, order.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects non-taxi orders and ended trips', async () => {
    const { customer, order } = await mkTrip({ status: 'COMPLETED' });
    await expect(svc.mint(customer.id, order.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('optional SMS send carries the link AND the plate in text', async () => {
    const { customer, order } = await mkTrip();
    sent.length = 0;
    await svc.mint(customer.id, order.id, { sendToPhone: `+${phoneBase + 900_000 + seq}` });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('/trip/');
    expect(sent[0]!.body).toContain('plate PAB'); // survives an unopened link
  });
});

describe('§6 public payload law', () => {
  it('exposes first names, driver identity, vehicle, live fix — and NOTHING private', async () => {
    const { customer, order } = await mkTrip();
    const { token } = await svc.mint(customer.id, order.id);
    const view = (await svc.publicView(token))!;
    expect(view).toBeTruthy();
    expect(view.passengerFirstName).toBe('Asha');
    expect(view.driver!.firstName).toBe('Deo');
    expect(view.driver!.plate).toMatch(/^PAB/);
    expect(view.driver!.vehicle).toBe('Silver Toyota Allion');
    expect(view.status).toBe('Trip in progress');
    expect(view.location).toMatchObject({ lat: 6.8013, lng: -58.1553 });

    // The forbidden list — enumerate-and-verify no leakage (§ verification).
    const flat = JSON.stringify(view);
    expect(flat).not.toContain('Secret Street'); // no addresses
    expect(flat).not.toContain('ShareTest'); // no surnames
    expect(flat).not.toContain(String(phoneBase).slice(0, 8)); // no phone numbers
    expect(flat).not.toContain(order.id); // no internal ids
    expect(flat).not.toContain(customer.id);
  });

  it('counts views', async () => {
    const { customer, order } = await mkTrip();
    const { token } = await svc.mint(customer.id, order.id);
    await svc.publicView(token);
    await svc.publicView(token);
    // Best-effort increments settle async — poll briefly.
    let count = 0;
    for (let i = 0; i < 20; i += 1) {
      count = (await prisma.tripShareToken.findUnique({ where: { tokenDigest: tripShareDigest(token) } }))!.viewCount;
      if (count >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('§6 lifecycle — revoke, trip-end grace, indistinguishable null', () => {
  it('revoked, expired-by-grace, and unknown tokens all read as the same null', async () => {
    // Revoked.
    const a = await mkTrip();
    const shareA = await svc.mint(a.customer.id, a.order.id);
    await svc.revoke(a.customer.id, shareA.token);
    expect(await svc.publicView(shareA.token)).toBeNull();

    // A stranger cannot revoke someone else's share.
    const b = await mkTrip();
    const shareB = await svc.mint(b.customer.id, b.order.id);
    const stranger = await mkUser('Nosy2');
    await expect(svc.revoke(stranger.id, shareB.token)).rejects.toMatchObject({ statusCode: 404 });

    // Alive during the trip; dead once the trip ended past the grace window.
    expect(await svc.publicView(shareB.token)).toBeTruthy();
    await prisma.order.update({ where: { id: b.order.id }, data: { status: 'COMPLETED', deliveredAt: new Date(Date.now() - 61 * 60_000) } });
    expect(await svc.publicView(shareB.token)).toBeNull();

    // Inside the grace it still shows (ended, no live fix).
    const c = await mkTrip();
    const shareC = await svc.mint(c.customer.id, c.order.id);
    await prisma.order.update({ where: { id: c.order.id }, data: { status: 'COMPLETED', deliveredAt: new Date(Date.now() - 10 * 60_000) } });
    const ended = (await svc.publicView(shareC.token))!;
    expect(ended.ended).toBe(true);
    expect(ended.location).toBeNull(); // no live fix after the trip

    // Unknown token — same null as everything else.
    expect(await svc.publicView('not-a-real-token-aaaaaaaa')).toBeNull();
  });
});
