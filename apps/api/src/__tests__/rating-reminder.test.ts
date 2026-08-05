import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService } from '../modules/notification/notification.service';
import { runRatingReminderSweep, RATINGS_FLAG } from '../modules/rating/rating-reminder';

// ---------------------------------------------------------------------------
// Movement R — R10: ONE reminder, never more. The sweep covers 24–48h-old
// finished orders; idempotence is the notification row itself (a re-run sends
// nothing), rated orders are skipped, fresh orders wait their turn, and the
// RATINGS_ENABLED flag silences the whole thing.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;
let app: FastifyInstance;
let notifications: NotificationService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_760_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Rem', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  return u;
}

async function makeDeliveredOrder(customerId: string, vendorId: string, hoursAgo: number) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `REM-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId, vendorId, status: 'DELIVERED',
      deliveryAddress: 'rem', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 900, subtotalMarkup: 0, subtotalCustomer: 900,
      deliveryFee: 0, totalAmount: 900, paymentMethod: 'CASH',
      deliveredAt: new Date(Date.now() - hoursAgo * HOUR),
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
  notifications = new NotificationService(app.prisma, app.io);
}, 30_000);

afterAll(async () => {
  await app.prisma.platformConfig.deleteMany({ where: { key: RATINGS_FLAG } });
  await app.prisma.rating.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

async function makeVendor() {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: owner.id }, create: { userId: owner.id }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Rem Vendor ${seq}`, slug: `rem-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Reminder Road', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return vendor;
}

describe('R10 — one reminder, never more', () => {
  it('reminds exactly once, skips rated and too-fresh orders, honours the flag', async () => {
    const vendor = await makeVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const due = await makeDeliveredOrder(customer.id, vendor.id, 30);      // in window
    await makeDeliveredOrder(customer.id, vendor.id, 10);                  // too fresh
    const ratedOrder = await makeDeliveredOrder(customer.id, vendor.id, 30);
    await app.prisma.rating.create({
      data: { orderId: ratedOrder.id, raterId: customer.id, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 5 },
    });

    // The sweep is global (other suites share swift_test2), so every assertion
    // is scoped to OUR orders — never to the global sent count.
    const remindersFor = (orderId: string) =>
      app.prisma.notification.count({
        where: { userId: customer.id, data: { path: ['orderId'], equals: orderId }, AND: { data: { path: ['kind'], equals: 'RATING_REMINDER' } } },
      });

    await runRatingReminderSweep(app.prisma, notifications);
    expect(await remindersFor(due.id)).toBe(1);
    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.id, data: { path: ['orderId'], equals: due.id } },
    });
    expect(note?.title).toBe('Got a minute?');
    expect(note?.body).toContain(vendor.name);
    // Rated + too-fresh orders: untouched.
    expect(await remindersFor(ratedOrder.id)).toBe(0);

    // Re-run: the notification row IS the dedupe — still exactly one.
    await runRatingReminderSweep(app.prisma, notifications);
    expect(await remindersFor(due.id)).toBe(1);

    // Flag off: the sweep is silent even with eligible orders.
    const later = await makeDeliveredOrder(customer.id, vendor.id, 25);
    await app.prisma.platformConfig.upsert({
      where: { key: RATINGS_FLAG },
      create: { key: RATINGS_FLAG, value: false },
      update: { value: false },
    });
    await runRatingReminderSweep(app.prisma, notifications);
    expect(await remindersFor(later.id)).toBe(0);
    await app.prisma.platformConfig.update({ where: { key: RATINGS_FLAG }, data: { value: true } });
    await runRatingReminderSweep(app.prisma, notifications);
    expect(await remindersFor(later.id)).toBe(1);
  });
});
