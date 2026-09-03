import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { BookingService } from '../modules/booking/booking.service';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] this suite installs its partial unique index by raw DDL on a db-push database (migrations carry it in CI) — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// ONE-SLOT-ONE-PERSON — reschedule (spec 2.4, SCH-D): reserve the NEW slot
// first (the partial unique is the judge), free the old in the SAME
// transaction. Under any interleaving: one winner, zero orphaned or
// double-held slots, the loser's original booking untouched. Both directions
// (customer / vendor) notify the other party.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let bookings: BookingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_820_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Rsc', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'rsc-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeServiceVendor() {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id,
      name: `Rsc Vendor ${seq}`, slug: `rsc-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'SERVICE', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Move Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Cuts', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: {
      vendorId: vendor.id, categoryId: category.id,
      name: 'Haircut', basePrice: 2000, isAvailable: true,
      fulfillment: 'APPOINTMENT',
      bookingConfig: {
        durationMinutes: 60,
        slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '09:00', end: '17:00' })),
      },
    },
  });
  return { owner, vendor, item };
}

function tomorrowAt(hour: number): Date {
  const d = new Date(Date.now() + DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0, 0));
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "bookings_item_slot_live_key" ON "bookings"("itemId", "slotStart") WHERE status <> 'CANCELLED'`,
  );
  bookings = new BookingService(app.prisma, app.io);
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.bookingException.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.booking.deleteMany({ where: { item: { vendorId: { in: createdVendorIds } } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

async function liveRowsAt(itemId: string, slot: Date): Promise<number> {
  return app.prisma.booking.count({ where: { itemId, slotStart: slot, status: { not: 'CANCELLED' } } });
}

describe('reschedule — both directions, notified', () => {
  it('customer moves the appointment: old freed, new holds status+order link, vendor notified', async () => {
    const { owner, item } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const original = await bookings.reserveSlot(item.id, customer.userId, tomorrowAt(10));

    const res = await app.inject({
      method: 'POST', url: `/api/v1/customer/bookings/${original.id}/reschedule`,
      headers: { authorization: `Bearer ${customer.token}` },
      payload: { newSlotStart: tomorrowAt(14).toISOString() },
    });
    expect(res.statusCode).toBe(200);
    const moved = res.json().data;
    expect(new Date(moved.slotStart).getTime()).toBe(tomorrowAt(14).getTime());
    expect(moved.status).toBe('RESERVED');

    expect((await app.prisma.booking.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('CANCELLED');
    expect(await liveRowsAt(item.id, tomorrowAt(10))).toBe(0);
    expect(await liveRowsAt(item.id, tomorrowAt(14))).toBe(1);

    const note = await app.prisma.notification.findFirst({
      where: { userId: owner.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(note?.title).toBe('Appointment moved');
    expect(note?.body).toContain('moved from');
  });

  it('vendor moves it too — same law, customer notified; foreign vendor probes 404', async () => {
    const { owner, item } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const original = await bookings.reserveSlot(item.id, customer.userId, tomorrowAt(9));

    const stranger = await makeServiceVendor();
    const probe = await app.inject({
      method: 'POST', url: `/api/v1/vendor/bookings/${original.id}/reschedule`,
      headers: { authorization: `Bearer ${stranger.owner.token}` },
      payload: { newSlotStart: tomorrowAt(15).toISOString() },
    });
    expect(probe.statusCode).toBe(404);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/vendor/bookings/${original.id}/reschedule`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { newSlotStart: tomorrowAt(15).toISOString() },
    });
    expect(res.statusCode).toBe(200);

    const note = await app.prisma.notification.findFirst({
      where: { userId: customer.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(note?.title).toBe('Your appointment moved');
  });

  it('same-slot reschedule is a calm no-op; dead bookings refuse to move', async () => {
    const { item } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const original = await bookings.reserveSlot(item.id, customer.userId, tomorrowAt(11));

    const same = await bookings.rescheduleBooking(original.id, tomorrowAt(11), { customerId: customer.userId });
    expect(same.moved).toBe(false);
    expect(await liveRowsAt(item.id, tomorrowAt(11))).toBe(1);

    await app.prisma.booking.update({ where: { id: original.id }, data: { status: 'COMPLETED' } });
    await expect(
      bookings.rescheduleBooking(original.id, tomorrowAt(12), { customerId: customer.userId }),
    ).rejects.toMatchObject({ code: 'NOT_RESCHEDULABLE' });
  });
});

describe('SCH-D: the reschedule race', () => {
  it('two bookings fighting for one target slot → one winner, loser keeps its original, zero orphans', async () => {
    const { item } = await makeServiceVendor();
    const alice = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const bob = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const a = await bookings.reserveSlot(item.id, alice.userId, tomorrowAt(9));
    const b = await bookings.reserveSlot(item.id, bob.userId, tomorrowAt(10));
    const target = tomorrowAt(16);

    const [ra, rb] = await Promise.allSettled([
      bookings.rescheduleBooking(a.id, target, { customerId: alice.userId }),
      bookings.rescheduleBooking(b.id, target, { customerId: bob.userId }),
    ]);
    const winners = [ra, rb].filter((r) => r.status === 'fulfilled');
    const losers = [ra, rb].filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'SLOT_TAKEN' });

    // Zero orphans, zero double-holds: target has exactly 1 live row; the
    // loser's ORIGINAL slot still has its live row; the winner's is freed.
    expect(await liveRowsAt(item.id, target)).toBe(1);
    const aliveA = await liveRowsAt(item.id, tomorrowAt(9));
    const aliveB = await liveRowsAt(item.id, tomorrowAt(10));
    expect(aliveA + aliveB).toBe(1); // exactly the loser's original survives
    const total = await app.prisma.booking.count({ where: { itemId: item.id, status: { not: 'CANCELLED' } } });
    expect(total).toBe(2); // one moved + one untouched — nothing extra exists
  });

  it('double-tap: the SAME booking rescheduled twice in parallel → one move total', async () => {
    const { item } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const original = await bookings.reserveSlot(item.id, customer.userId, tomorrowAt(9));
    const target = tomorrowAt(13);

    const results = await Promise.allSettled([
      bookings.rescheduleBooking(original.id, target, { customerId: customer.userId }),
      bookings.rescheduleBooking(original.id, target, { customerId: customer.userId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await liveRowsAt(item.id, target)).toBe(1);
    expect(await liveRowsAt(item.id, tomorrowAt(9))).toBe(0);
    const live = await app.prisma.booking.count({ where: { itemId: item.id, status: { not: 'CANCELLED' } } });
    expect(live).toBe(1); // never two live rows out of one booking
  });
});
