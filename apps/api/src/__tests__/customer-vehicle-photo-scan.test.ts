/**
 * [Row 312 · COORD ruling 23 Oct 01:28Z] UNDER THE BYPASS, A VEHICLE PHOTO OWED A SCAN, FAILED OR GONE IS
 * HIDDEN ON EVERY CUSTOMER AND RIDER SURFACE TOO (ride and driver card, delivery tracking), same states as
 * for admins: null URL plus vehiclePhotoScan, fail closed. The plate, the vehicle and the driver's own
 * photo (an avatar upload, which the bypass never covers) stay: safety identification is unchanged.
 * Harness = the app's own wiring (registerUploadPhotoScan, as app.ts calls it before any route).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerUploadPhotoScan } from '../lib/photo-scan-filter';

const DAY = 24 * 60 * 60 * 1000;
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
let app: FastifyInstance;
const createdUserIds: string[] = [];
const keys: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({ data: {
    phone: `+59200279${String(seq).padStart(2, '0')}`, firstName: 'Scan', lastName: `User${seq}`, roles, activeRole,
    isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/trust.jpg',
    ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
  } });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: user.id, token, refreshToken: nanoid(48), deviceId: 'scan-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
  return { userId: user.id, token };
}

/** A stored vehicle photo with the given scan debt (none = scanned at upload). */
async function photo(debt: { result: string | null } | null): Promise<string> {
  const key = `/uploads/vehicles/scan-${RUN}-${keys.length}/car.png`;
  keys.push(key);
  if (debt) {
    await app.prisma.uploadScanDebt.create({ data: {
      surface: 'vehicle-photo', reason: 'bypass', fileKey: key, sha256: `cvps-${RUN}-${keys.length}`,
      ...(debt.result ? { result: debt.result, rescannedAt: new Date(), quarantinedAt: new Date() } : {}),
    } });
  }
  return key;
}

async function rideWith(vehiclePhotoUrl: string) {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const du = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await app.prisma.driver.create({ data: {
    userId: du.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021, vehicleColor: 'Silver',
    licensePlate: `SC-${RUN}-${seq}`, vehiclePhotoUrl, driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
  } });
  const ride = await app.prisma.order.create({ data: {
    orderNumber: `SCAN-${nanoid(8)}`, orderType: 'TAXI', customerId: customer.userId, driverId: driver.id, status: 'DRIVER_ASSIGNED',
    deliveryAddress: 'B', deliveryLat: 6.75, deliveryLng: -58.15, pickupAddress: 'A', pickupLat: 6.81, pickupLng: -58.155,
    subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
  } });
  return app.inject({ method: 'GET', url: `/api/v1/rides/${ride.id}`, headers: { authorization: `Bearer ${customer.token}` } });
}

async function deliveryWith(vehiclePhotoUrl: string) {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  const ru = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
  const rider = await app.prisma.rider.create({ data: {
    userId: ru.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', vehicleMake: 'Honda', vehicleModel: 'Wave', vehicleColor: 'Red',
    licensePlate: `SD-${RUN}-${seq}`, vehiclePhotoUrl,
  } });
  const order = await app.prisma.order.create({ data: {
    orderNumber: `SCAND-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: customer.userId, riderId: rider.id, status: 'PICKED_UP',
    deliveryAddress: 'Home', deliveryLat: 6.8, deliveryLng: -58.15,
    subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
  } });
  return app.inject({ method: 'GET', url: `/api/v1/customer/orders/${order.id}`, headers: { authorization: `Bearer ${customer.token}` } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // The app's own wiring: app.ts calls this right after the socket plugin, before any route.
  registerUploadPhotoScan(app);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.uploadScanDebt.deleteMany({ where: { fileKey: { in: keys } } }).catch(() => {});
  if (createdUserIds.length > 0) {
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('[Row 312 · ruling 01:28Z] customers never get a vehicle photo before a clean scan', () => {
  it('the ride card: owed -> hidden (AWAITING), failed -> hidden (FAILED); plate, vehicle and the driver photo stay', async () => {
    for (const [debt, scan] of [[{ result: null }, 'AWAITING'], [{ result: 'UNSCANNABLE' }, 'FAILED']] as const) {
      const key = await photo(debt);
      const res = await rideWith(key);
      expect(res.statusCode, res.body).toBe(200);
      const d = res.json().data.driver;
      expect(d.vehiclePhotoUrl).toBeNull();
      expect(d.vehiclePhotoScan).toBe(scan);
      expect(res.body).not.toContain(key);
      expect(d.licensePlate).toContain('SC-');
      expect(d.vehicleModel).toBe('Allion');
      expect(d.user.avatar).toBe('/uploads/avatars/trust.jpg');
    }
  });

  it('the delivery tracking card: the same; a photo scanned at upload or closed CLEAN is shown as before', async () => {
    const owed = await photo({ result: null });
    const hidden = (await deliveryWith(owed)).json().data.rider;
    expect(hidden).toMatchObject({ vehiclePhotoUrl: null, vehiclePhotoScan: 'AWAITING', vehicleMake: 'Honda' });
    expect(hidden.licensePlate).toContain('SD-');
    for (const key of [await photo(null), await photo({ result: 'CLEAN' })]) {
      const shown = (await deliveryWith(key)).json().data.rider;
      expect(shown.vehiclePhotoUrl).toBe(key);
      expect(shown.vehiclePhotoScan).toBeUndefined();
    }
  });
});
