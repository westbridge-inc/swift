import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Phase-3 safety (pre-launch audit: no SOS was a rides-vertical blocker). A
// ride participant can raise an emergency; it alerts every admin and leaves an
// audit-log trace. A non-participant cannot touch someone else's ride SOS.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_700_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Sos', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(), ...(roles.includes('CUSTOMER') && { customer: { create: {} } }) } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sos', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  return { userId: user.id, token };
}

function inject(url: string, payload: unknown, token: string) {
  return app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.ready();
});

afterAll(async () => {
  // order_status_logs are append-only (immutable audit); deleting the order
  // cascades them away. SosAlert has no FK to the order (orderId is a plain
  // string), so it is deleted explicitly by actor.
  await app.prisma.sosAlert.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('ride SOS', () => {
  it('the passenger can raise it; it alerts admins and logs an audit trail', async () => {
    const admin = await makeUser(['ADMIN']);
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeUser(['MOVER']);
    const driver = await app.prisma.driver.create({ data: { userId: driverUser.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'White', licensePlate: `SOS ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x' } });
    const ride = await app.prisma.order.create({
      data: { orderNumber: `SOS-${nanoid(8)}`, orderType: 'TAXI', customerId: passenger.userId, driverId: driver.id, status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY', pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13, subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH' },
    });

    const res = await inject(`/api/v1/rides/${ride.id}/sos`, { lat: 6.81, lng: -58.14, note: 'being followed' }, passenger.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.acknowledged).toBe(true);

    // Reconciled onto the ONE SOS engine (standing order #17): a ride panic is a
    // first-class SosAlert, ACTIVE at once (no grace — the button has no cancel
    // affordance), with the counterparty (the driver) captured for the war-room.
    const alertId = res.json().data.sosAlertId as string;
    expect(alertId).toBeTruthy();
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: alertId } });
    expect(alert.status).toBe('ACTIVE');
    expect(alert.graceEndsAt).toBeNull();
    expect(alert.orderId).toBe(ride.id);
    expect(alert.orderType).toBe('TAXI');
    expect(alert.actorUserId).toBe(passenger.userId);
    expect(alert.actorRole).toBe('CUSTOMER');
    expect(alert.counterpartyUserId).toBe(driverUser.userId);

    // Ops paged through the engine's fan-out (kind is the engine's 'sos_active').
    const adminNote = await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: { contains: 'SOS' } } });
    expect(adminNote).not.toBeNull();
    expect((adminNote!.data as { kind?: string })?.kind).toBe('sos_active');

    // The free-text reason + coords stay on the order's immutable timeline.
    const auditLog = await app.prisma.orderStatusLog.findFirst({ where: { orderId: ride.id, note: { contains: 'SOS' } } });
    expect(auditLog).not.toBeNull();
    expect(auditLog!.note).toContain('being followed');
  });

  it('the driver can raise it too — actorRole MOVER, counterparty is the passenger', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const driverUser = await makeUser(['MOVER']);
    const driver = await app.prisma.driver.create({ data: { userId: driverUser.userId, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'Silver', licensePlate: `SOS ${seq}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x' } });
    const ride = await app.prisma.order.create({
      data: { orderNumber: `SOS-${nanoid(8)}`, orderType: 'TAXI', customerId: passenger.userId, driverId: driver.id, status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY', pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13, subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH' },
    });

    const res = await inject(`/api/v1/rides/${ride.id}/sos`, {}, driverUser.token);
    expect(res.statusCode).toBe(200);
    const alert = await app.prisma.sosAlert.findUniqueOrThrow({ where: { id: res.json().data.sosAlertId } });
    expect(alert.status).toBe('ACTIVE');
    expect(alert.actorUserId).toBe(driverUser.userId);
    expect(alert.actorRole).toBe('MOVER');
    expect(alert.counterpartyUserId).toBe(passenger.userId);
  });

  it('a stranger cannot raise SOS on someone else’s ride', async () => {
    const passenger = await makeUser(['CUSTOMER']);
    const stranger = await makeUser(['CUSTOMER']);
    const ride = await app.prisma.order.create({
      data: { orderNumber: `SOS-${nanoid(8)}`, orderType: 'TAXI', customerId: passenger.userId, status: 'RIDE_IN_PROGRESS', fulfillment: 'DELIVERY', pickupAddress: 'A', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'B', deliveryLat: 6.82, deliveryLng: -58.13, subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, taxiFareTotal: 2000, paymentMethod: 'CASH' },
    });
    const res = await inject(`/api/v1/rides/${ride.id}/sos`, {}, stranger.token);
    expect(res.statusCode).toBe(404);
  });
});
