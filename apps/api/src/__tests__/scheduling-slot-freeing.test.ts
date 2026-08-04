import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { OrderService } from '../modules/order/order.service';
import { BookingService } from '../modules/booking/booking.service';
import { autoCancelUnresponsiveOrder, type JobContext } from '../jobs/queue';

// ---------------------------------------------------------------------------
// ONE-SLOT-ONE-PERSON, SCH-C: EVERY order-death path frees its appointment
// slot in the same breath — customer cancel (worked before, pinned), vendor
// reject and the no-response auto-cancel (both found LEAKING: the booking
// stayed CONFIRMED forever, permanently blocking the provider's chair). After
// each death the exact slot must be reservable again — the partial unique
// ignoring CANCELLED rows is the law that makes freeing == selling.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let orders: OrderService;
let bookings: BookingService;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_840_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Sch', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'sch-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

/** A SERVICE vendor with one bookable listing (daily 09:00–17:00, 60 min). */
async function makeServiceVendor() {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vendorOwner = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vendorOwner.id,
      name: `Sch Vendor ${seq}`, slug: `sch-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'SERVICE', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({
    data: { vendorId: vendor.id, name: 'Cuts', sortOrder: 0 },
  });
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

/** Tomorrow 10:00 on the UTC face (the codebase's local-wall-clock convention). */
function slotTomorrow(hour: number): Date {
  const d = new Date(Date.now() + DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0, 0, 0));
}

async function makeAppointmentOrder(customerUserId: string, vendorId: string, itemId: string, slot: Date, status: 'PENDING' | 'ACCEPTED') {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SCH-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customerUserId, vendorId, status,
      deliveryAddress: 'chair', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 0, totalAmount: 2000, paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  const booking = await bookings.reserveSlot(itemId, customerUserId, slot, order.id);
  return { order, booking };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "bookings_item_slot_live_key" ON "bookings"("itemId", "slotStart") WHERE status <> 'CANCELLED'`,
  );
  orders = new OrderService(app.prisma, app.io);
  bookings = new BookingService(app.prisma);
});

afterAll(async () => {
  await app.prisma.booking.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  // orderStatusLog is append-only by extension guard; deleting the parent
  // order cascades its logs at the DB level (the sanctioned path).
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

async function expectSlotFreedAndResellable(bookingId: string, itemId: string, slot: Date, nextCustomerId: string) {
  const booking = await app.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  expect(booking.status).toBe('CANCELLED');
  // Freeing == selling: the exact slot reserves cleanly for the next person.
  const rebooked = await bookings.reserveSlot(itemId, nextCustomerId, slot);
  expect(rebooked.status).toBe('RESERVED');
  await app.prisma.booking.delete({ where: { id: rebooked.id } });
}

describe('SCH-C: every order death frees its slot', () => {
  it('vendor REJECT cancels the booking and the chair sells again (was leaking)', async () => {
    const { owner, vendor, item } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const slot = slotTomorrow(10);
    const { order, booking } = await makeAppointmentOrder(customer.userId, vendor.id, item.id, slot, 'ACCEPTED');

    const res = await app.inject({
      method: 'PUT', url: `/api/v1/vendor/orders/${order.id}/reject`,
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { reason: 'Chair broke' },
    });
    expect(res.statusCode).toBe(200);
    await expectSlotFreedAndResellable(booking.id, item.id, slot, customer.userId);
  });

  it('no-response AUTO-CANCEL cancels the booking too (was leaking)', async () => {
    const { vendor, item } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const slot = slotTomorrow(11);
    const { order, booking } = await makeAppointmentOrder(customer.userId, vendor.id, item.id, slot, 'PENDING');

    const ctx = { prisma: app.prisma, io: app.io, log: app.log } as unknown as JobContext;
    expect(await autoCancelUnresponsiveOrder(ctx, order.id)).toBe(true);
    await expectSlotFreedAndResellable(booking.id, item.id, slot, customer.userId);
  });

  it('customer CANCEL keeps freeing the slot (pinned — worked before)', async () => {
    const { vendor, item } = await makeServiceVendor();
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const slot = slotTomorrow(12);
    const { order, booking } = await makeAppointmentOrder(customer.userId, vendor.id, item.id, slot, 'PENDING');

    await orders.cancelOrder(order.id, customer.userId, 'changed my mind');
    await expectSlotFreedAndResellable(booking.id, item.id, slot, customer.userId);
  });
});
