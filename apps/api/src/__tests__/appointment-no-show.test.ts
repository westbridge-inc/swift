import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { exportPersonalData } from '../modules/user/data-export';
import { NO_SHOW_REASON } from '../modules/booking/appointment-no-show';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { guyanaDayKey, instantOfGuyanaWallClock } from '../utils/guyana-day';

// ---------------------------------------------------------------------------
// [BOOK-FU2 · owner B3, 28 Oct 2026] "CUSTOMER DIDN'T COME", through the real mounted routes on real Postgres.
//
// The business taps it on an appointment it accepted, once the appointment's time has started. The order closes
// (CANCELLED, the booking freed), and ONE record is kept with the order: which booking, when, and who at the
// business recorded it. No fee, no strike, no money. The customer is told in neutral words. A person at Swift sees
// the customers with repeated records (GET /admin/missed-appointments, numbers masked); the customer's own data
// export carries the record. The Terms and Privacy words are pinned in legal-appointment-rules.test.ts.
// ---------------------------------------------------------------------------

// This file's fixture block (+5920864nnn, 11 characters): no phone literal, generator or purge prefix under apps/,
// packages/, tools/, scripts/ or deploy/ contains "+5920864".
const PHONE_PREFIX = '+5920864';
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;

let app: FastifyInstance;
let seq = 0;
const userIds: string[] = [];
const vendorIds: string[] = [];

type Actor = { userId: string; token: string; phone: string };

function gyDay(offset: number): string {
  const [y, m, d] = guyanaDayKey(new Date()).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + offset)).toISOString().slice(0, 10);
}
function gy(dayKey: string, hour: number, minute = 0): Date {
  const [y, m, d] = dayKey.split('-').map(Number);
  return instantOfGuyanaWallClock(new Date(Date.UTC(y!, m! - 1, d!, hour, minute)));
}

async function makeUser(firstName: string, roles: UserRole[], activeRole: UserRole, opts: { admin?: string[] } = {}): Promise<Actor> {
  seq += 1;
  const phone = `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName, lastName: `NS-${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
      ...(opts.admin && { admin: { create: { permissions: opts.admin } } }),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP',
      deviceId: `ns-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token, phone };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

let provider: Actor;
let otherProvider: Actor;
let vendorId: string;
let cutId: string;
let slotCursor = 0;

/** A booked and ACCEPTED appointment (the real checkout and accept), then its time moved to `startedMinutesAgo`
 *  in the past, as if the appointment's time had come. A negative value leaves it in the future. */
async function acceptedAppointment(customer: Actor, startedMinutesAgo: number, opts: { accept?: boolean } = {}) {
  slotCursor += 1;
  const future = gy(gyDay(3 + Math.floor(slotCursor / 20)), 1 + (slotCursor % 20), 0);
  expect((await call('DELETE', '/api/v1/customer/cart', customer.token)).statusCode).toBe(200);
  const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId, itemId: cutId, quantity: 1 });
  expect(added.statusCode, added.body).toBe(201);
  const placed = await call('POST', '/api/v1/customer/checkout', customer.token, {
    paymentMethod: 'CASH',
    appointments: [{ itemId: cutId, slotStart: future.toISOString() }],
  });
  expect(placed.statusCode, placed.body).toBe(200);
  const order = placed.json().data.order as { id: string; orderNumber: string };
  if (opts.accept !== false) {
    const accepted = await call('PUT', `/api/v1/vendor/orders/${order.id}/accept`, provider.token, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
  }
  if (startedMinutesAgo >= 0) {
    // A distinct past minute per case, so no two moved bookings share one time.
    const start = new Date(Math.floor((Date.now() - startedMinutesAgo * MINUTE) / MINUTE) * MINUTE - slotCursor * 31 * MINUTE);
    await app.prisma.order.update({ where: { id: order.id }, data: { appointmentSlot: start } });
    await app.prisma.booking.updateMany({ where: { orderId: order.id }, data: { slotStart: start, slotEnd: new Date(start.getTime() + 30 * MINUTE) } });
  }
  const booking = await app.prisma.booking.findFirst({ where: { orderId: order.id, status: { not: 'CANCELLED' } } });
  return { order, booking };
}

const noShow = (orderId: string, as: Actor = provider) => call('PUT', `/api/v1/vendor/orders/${orderId}/no-show`, as.token, {});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  vi.stubEnv('LIFECYCLE_V2', '1');

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  provider = await makeUser('Noel', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: provider.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: 'NS Barber', slug: `ns-barber-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}900`, addressLine1: '7 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Chair', sortOrder: 0 } });
  cutId = (await app.prisma.item.create({
    data: {
      vendorId, categoryId: category.id, name: 'NS Cut', basePrice: 2000, isAvailable: true, fulfillment: 'APPOINTMENT',
      bookingConfig: { durationMinutes: 30, slots: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: '00:00', end: '24:00' })) },
    },
  })).id;

  otherProvider = await makeUser('Oona', ['VENDOR_OWNER'], 'VENDOR_OWNER');
  const otherOwner = await app.prisma.vendorOwner.create({ data: { userId: otherProvider.userId } });
  const other = await app.prisma.vendor.create({
    data: {
      ownerId: otherOwner.id, name: 'NS Other', slug: `ns-other-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: `${PHONE_PREFIX}901`, addressLine1: '9 Chair Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorIds.push(other.id);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: userIds } }, { vendorId: { in: vendorIds } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: userIds } }, { entityId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:no-show fixtures');
  await purgeSensitiveReadLogs(app.prisma, { OR: [{ actorUserId: { in: userIds } }, { subjectId: { in: [...orderIds, ...userIds] } }] }, 'test-cleanup:no-show fixture reads');
  if (orderIds.length > 0) {
    await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
  }
  await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: userIds } }] } });
  await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...vendorIds] } } });
  await app.prisma.orderOutbox.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.appointmentNoShow.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.booking.deleteMany({ where: { item: { vendorId: { in: vendorIds } } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[BOOK-FU2 · owner B3] the business records "Customer didn\'t come"', () => {
  it('closes an accepted appointment whose time has started, with ONE record: which booking, when, who; no fee, no strike', async () => {
    const customer = await makeUser('Rae', ['CUSTOMER'], 'CUSTOMER');
    const { order, booking } = await acceptedAppointment(customer, 20);
    expect(booking?.status).toBe('CONFIRMED');

    const before = Date.now();
    const res = await noShow(order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.status).toBe('CANCELLED');

    const closed = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed).toMatchObject({ status: 'CANCELLED', cancelledBy: provider.userId, cancellationReason: NO_SHOW_REASON });
    expect(Number(closed.lateCancelFeeDue)).toBe(0);
    // The business gets its time back: the booking is freed in the same commit.
    expect((await app.prisma.booking.findUniqueOrThrow({ where: { id: booking!.id } })).status).toBe('CANCELLED');
    // The status log names who closed it and why.
    const log = await app.prisma.orderStatusLog.findFirstOrThrow({ where: { orderId: order.id, status: 'CANCELLED' } });
    expect(log).toMatchObject({ changedBy: provider.userId, note: NO_SHOW_REASON });

    // THE record, exactly as Privacy section 6 describes it, and nothing more.
    const rows = await app.prisma.appointmentNoShow.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    const { id, tenantId, recordedAt, ...facts } = rows[0]!;
    expect(id).toBeTruthy();
    expect(tenantId).toBe(closed.tenantId);
    expect(facts).toEqual({ orderId: order.id, bookingId: booking!.id, recordedByUserId: provider.userId });
    expect(recordedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(recordedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // No strike for the customer.
    expect(await app.prisma.strike.count({ where: { userId: customer.userId } })).toBe(0);

    // The customer is told, in neutral words, and the tap opens the booking's own order.
    const notice = await app.prisma.notification.findFirstOrThrow({ where: { userId: customer.userId, title: 'Appointment closed' } });
    expect(notice.body).toBe(`Your booking ${order.orderNumber} is closed: the business recorded that you didn't come. There is no fee and no strike. If that isn't right, contact Swift Support.`);
    expect(notice.data).toEqual({ orderId: order.id, status: 'CANCELLED', audience: 'customer' });

    // The customer's own order screen offers no cancel after it.
    const mine = await call('GET', `/api/v1/customer/orders/${order.id}`, customer.token);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.json().data.status).toBe('CANCELLED');
    expect(mine.json().data.canCancel).toBe(false);
  });

  it('before the appointment\'s time: refused, nothing written', async () => {
    const customer = await makeUser('Sol', ['CUSTOMER'], 'CUSTOMER');
    const { order } = await acceptedAppointment(customer, -1);
    const res = await noShow(order.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('APPOINTMENT_NOT_STARTED');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ACCEPTED');
    expect(await app.prisma.appointmentNoShow.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('a booking the business never accepted: refused (the business declines it instead), nothing written', async () => {
    const customer = await makeUser('Tia', ['CUSTOMER'], 'CUSTOMER');
    const { order } = await acceptedAppointment(customer, 20, { accept: false });
    const res = await noShow(order.id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('NO_SHOW_NOT_OPEN');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING');
    expect(await app.prisma.appointmentNoShow.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('a second tap changes nothing: one record, ever', async () => {
    const customer = await makeUser('Uma', ['CUSTOMER'], 'CUSTOMER');
    const { order } = await acceptedAppointment(customer, 25);
    expect((await noShow(order.id)).statusCode).toBe(200);
    const again = await noShow(order.id);
    expect(again.statusCode, again.body).toBe(409);
    expect(await app.prisma.appointmentNoShow.count({ where: { orderId: order.id } })).toBe(1);
    expect(await app.prisma.notification.count({ where: { userId: customer.userId, title: 'Appointment closed' } })).toBe(1);
  });

  it('the same operate gate as complete-appointment: a store Swift suspended, or a closed one, is refused the same way; a weekly-fee hold still finishes accepted work', async () => {
    const customer = await makeUser('Quin', ['CUSTOMER'], 'CUSTOMER');
    const { order } = await acceptedAppointment(customer, 20);
    try {
      for (const hold of [{ status: 'SUSPENDED', suspensionSource: 'ADMIN' }, { status: 'CLOSED', suspensionSource: null }] as const) {
        await app.prisma.vendor.update({ where: { id: vendorId }, data: hold });
        const completing = await call('PUT', `/api/v1/vendor/orders/${order.id}/complete-appointment`, provider.token, {});
        const res = await noShow(order.id);
        expect(completing.statusCode, `${hold.status} complete-appointment`).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, `${hold.status} ${res.body}`).toBe(completing.statusCode);
        expect(res.json().error.code, hold.status).toBe(completing.json().error.code);
        expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ACCEPTED');
        expect(await app.prisma.appointmentNoShow.count({ where: { orderId: order.id } })).toBe(0);
      }
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'SUSPENDED', suspensionSource: 'BILLING' } });
      const res = await noShow(order.id);
      expect(res.statusCode, res.body).toBe(200);
      expect(await app.prisma.appointmentNoShow.count({ where: { orderId: order.id } })).toBe(1);
    } finally {
      await app.prisma.vendor.update({ where: { id: vendorId }, data: { status: 'ACTIVE', suspensionSource: null } });
    }
  });

  it('another business cannot record it: not found, nothing written', async () => {
    const customer = await makeUser('Vic', ['CUSTOMER'], 'CUSTOMER');
    const { order } = await acceptedAppointment(customer, 20);
    const res = await noShow(order.id, otherProvider);
    expect(res.statusCode, res.body).toBe(404);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('ACCEPTED');
    expect(await app.prisma.appointmentNoShow.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe('[BOOK-FU2 · REVIEW-F S3-1 on #2201] the server says when the partner app may offer it: noShow.allowed', () => {
  const detail = async (orderId: string) => {
    const res = await call('GET', `/api/v1/vendor/orders/${orderId}`, provider.token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data.noShow as { allowed: boolean } | undefined;
  };
  const row = async (bookingId: string, slot: Date) => {
    const from = new Date(slot.getTime() - DAY).toISOString();
    const to = new Date(slot.getTime() + DAY).toISOString();
    const res = await call('GET', `/api/v1/vendor/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, provider.token);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().data as Array<{ id: string; noShow?: { allowed: boolean } }>).find((b) => b.id === bookingId)?.noShow;
  };

  it('true only on an accepted appointment whose time has started; false before it, before acceptance, and after it is recorded', async () => {
    const customer = await makeUser('Bea', ['CUSTOMER'], 'CUSTOMER');
    const future = await acceptedAppointment(customer, -1);
    expect(await detail(future.order.id)).toEqual({ allowed: false });
    expect(await row(future.booking!.id, future.booking!.slotStart)).toEqual({ allowed: false });

    const pending = await acceptedAppointment(customer, 50, { accept: false });
    expect(await detail(pending.order.id)).toEqual({ allowed: false });

    const started = await acceptedAppointment(customer, 55);
    expect(await detail(started.order.id)).toEqual({ allowed: true });
    expect(await row(started.booking!.id, started.booking!.slotStart)).toEqual({ allowed: true });
    // The word and the route agree: it is recorded, and the word turns false.
    expect((await noShow(started.order.id)).statusCode).toBe(200);
    expect(await detail(started.order.id)).toEqual({ allowed: false });
  });
});

describe('[BOOK-FU2 · owner B3] a person reviews repeat cases; the customer sees their record', () => {
  it('the review lists a customer with two records (count, latest date, number masked), not one with a single record', async () => {
    const repeat = await makeUser('Wren', ['CUSTOMER'], 'CUSTOMER');
    const once = await makeUser('Xia', ['CUSTOMER'], 'CUSTOMER');
    for (const minutes of [40, 30]) {
      const { order } = await acceptedAppointment(repeat, minutes);
      expect((await noShow(order.id)).statusCode).toBe(200);
    }
    const { order: single } = await acceptedAppointment(once, 35);
    expect((await noShow(single.id)).statusCode).toBe(200);

    const reviewer = await makeUser('Yan', ['ADMIN'], 'ADMIN', { admin: ['user.risk.read'] });
    const res = await call('GET', '/api/v1/admin/missed-appointments', reviewer.token);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as Array<{ customer: { id: string; phone?: string; firstName?: string }; missedAppointments: number; lastRecordedAt: string }>;
    const row = rows.find((r) => r.customer.id === repeat.userId);
    expect(row?.missedAppointments).toBe(2);
    expect(row?.customer.firstName).toBe('Wren');
    expect(row?.customer.phone).not.toBe(repeat.phone);
    expect(row?.customer.phone).toMatch(/•/);
    expect(rows.some((r) => r.customer.id === once.userId), 'one record is not a repeat').toBe(false);

    // A grant that cannot read risk signals is refused.
    const plain = await makeUser('Zed', ['ADMIN'], 'ADMIN', { admin: ['dashboard.read'] });
    expect((await call('GET', '/api/v1/admin/missed-appointments', plain.token)).statusCode).toBe(403);
  });

  it('the customer\'s data export carries the record: the order, the booking and when — not who at the business', async () => {
    const customer = await makeUser('Ari', ['CUSTOMER'], 'CUSTOMER');
    const { order, booking } = await acceptedAppointment(customer, 45);
    expect((await noShow(order.id)).statusCode).toBe(200);
    const exported = await exportPersonalData(app.prisma, customer.userId) as unknown as Record<string, unknown>;
    const missed = exported['missedAppointments'] as Array<Record<string, unknown>>;
    expect(missed).toHaveLength(1);
    expect(Object.keys(missed[0]!).sort()).toEqual(['bookingId', 'orderId', 'recordedAt']);
    expect(missed[0]).toMatchObject({ orderId: order.id, bookingId: booking!.id });
  });
});
