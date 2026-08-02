import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { RatingService } from '../modules/rating/rating.service';

// Safety spec, "Rating flags: reuse the ratings/quality engine — safety-tagged
// categories route here automatically." The laws: a safety tag on a rating
// opens ONE IncidentCase via the RATING_FLAG intake with the right category,
// subject, and reporter; ordinary tags open nothing; the most severe tag
// decides; and the rating itself succeeds regardless.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const io = { to: () => ({ emit: () => {} }) } as unknown as Server;
const svc = new RatingService(prisma, io);

const userIds: string[] = [];
const orderIds: string[] = [];
const driverIds: string[] = [];
let seq = 0;
const phoneBase = 592_880_000_000 + Math.floor(Math.random() * 9_000_000);

async function mkUser(first: string, roles: ('CUSTOMER' | 'DRIVER')[] = ['CUSTOMER']) {
  seq += 1;
  const u = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: first, lastName: 'FlagTest', roles, activeRole: roles[0]!, isPhoneVerified: true },
  });
  userIds.push(u.id);
  return u;
}

async function mkCompletedTrip() {
  const customer = await mkUser('Rita');
  const driverUser = await mkUser('Dax', ['DRIVER']);
  const driver = await prisma.driver.create({
    data: {
      userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Premio', vehicleYear: 2018,
      vehicleColor: 'White', licensePlate: `PCC ${Math.floor(1000 + Math.random() * 8999)}`,
      driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
    },
  });
  driverIds.push(driver.id);
  const order = await prisma.order.create({
    data: {
      customerId: customer.id, driverId: driver.id,
      orderType: 'TAXI', status: 'COMPLETED', orderNumber: `RF-${nanoid(8)}`,
      fulfillment: 'DELIVERY',
      pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.16,
      deliveryAddress: 'B', deliveryLat: 6.81, deliveryLng: -58.15,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0,
      totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  return { customer, driverUser, order };
}

const caseFor = (orderId: string) => prisma.incidentCase.findFirst({ where: { orderId, intake: 'RATING_FLAG' } });

/** The flag hook is fire-and-forget — settle it with a short poll. */
async function waitForCase(orderId: string) {
  for (let i = 0; i < 30; i += 1) {
    const c = await caseFor(orderId);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.incidentCase.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.rating.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('rating → incident bridge (RATING_FLAG intake)', () => {
  it('a safety-tagged driver rating opens a case with the right category/subject/reporter', async () => {
    const { customer, driverUser, order } = await mkCompletedTrip();
    await svc.rateOrder(customer.id, order.id, { driverScore: 1, driverComment: 'Ran two red lights', driverTags: ['Unsafe_Driving'] });

    const c = await waitForCase(order.id);
    expect(c).toBeTruthy();
    expect(c!.category).toBe('DRIVING_DANGEROUS');
    expect(c!.subjectUserId).toBe(driverUser.id);
    expect(c!.reporterUserId).toBe(customer.id);
    expect(c!.severity).toBe('S2');
  });

  it('the most severe tag decides the category (identity beats driving)', async () => {
    const { customer, order } = await mkCompletedTrip();
    await svc.rateOrder(customer.id, order.id, { driverScore: 1, driverTags: ['unsafe_driving', 'different_driver'] });
    const c = await waitForCase(order.id);
    expect(c!.category).toBe('IDENTITY_MISMATCH');
    expect(c!.severity).toBe('S1');
  });

  it('ordinary tags and clean ratings open nothing; the rating itself always lands', async () => {
    const { customer, order } = await mkCompletedTrip();
    await svc.rateOrder(customer.id, order.id, { driverScore: 5, driverTags: ['friendly', 'clean_car'] });
    await new Promise((r) => setTimeout(r, 300));
    expect(await caseFor(order.id)).toBeNull();
    expect(await prisma.rating.count({ where: { orderId: order.id } })).toBe(1);
  });
});
